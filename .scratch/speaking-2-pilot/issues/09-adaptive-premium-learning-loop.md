# 09 — Связать Speaking с планом, Premium и Voice Tutor

Status: done
Blocked by: 08
Spec: `.scratch/speaking-2-pilot/spec.md#индивидуальный-план-и-premium`

Final review: Standards `ZERO_FINDINGS`; Spec `ZERO_FINDINGS` (2026-08-08).

## Final19 — atomic fallback authority and file rollback freeze — 2026-08-08

The explicit Voice Tutor fallback transition now re-enters the same owner-serialized authority boundary as
create/replay/recovery. File storage takes its fresh authority time after the owner queue; PostgreSQL locks the
user, takes `clock_timestamp()`, requires the active Base subscription and Premium entitlement, then locks and
rebuilds any exact pronunciation attempt/ref/assistance/mastery/30-day-expiry pointer before status, billing,
outcome, delivery or nonce can change. Revocation, Base expiry, assistance, ref drift and the exact expiry boundary
therefore return the documented 403/409 with a byte-identical stored session and no text AI operation.

The fresh-create ticket catch falls back only for the explicit `VOICE_TUTOR_PROVIDER_UNAVAILABLE` class.
Authorization, pronunciation, session-integrity, expiry and ticket-conflict errors propagate instead of being
converted to a 201 text/local response. File reservation snapshots and restores the complete in-memory state on
any throw, preventing pre-validation expiry reconciliation from leaking into later persistence; PostgreSQL uses
the corresponding transaction rollback. Initial TDD RED was 16 total / 11 pass / 5 intended failures; the final
integrity-classification regression was separately RED at 18/19. GREEN is 19/19 focused file/API, 53/53 focused
Voice Tutor, 41/41 disposable PostgreSQL and 1259 total in the full suite (1218 pass, 41 expected PostgreSQL skip,
0 fail). Lint, syntax/check (348 JS), frontend build (482 assets), full
Chromium + adaptive E2E, both secret scans and `git diff --check` are green. No provider/paid call, commit, push or
deploy was performed; the tree is frozen for fresh Standards → Spec review and the single parent-owned commit.

## Что сделать

Каждая надёжная попытка превращается в навыковые evidence и реально меняет индивидуальный план. Обычный подписчик получает полный текущий разбор, а Premium — продольный фонетический отчёт, целевые упражнения, сравнение попыток и Voice Tutor из конкретной ошибки.

## Границы

- Входит evidence по четырём заданиям, критериям, словам/фонемам и качеству сигнала.
- Входит adaptive selection, targeted re-check на новом материале и защита от assisted/low-confidence mastery.
- Входит base/Premium entitlement contract и расширенный отчёт без ухудшения base.
- Не входят VK/Robokassa и изменение общей коммерческой модели.

## Файлы

- adaptive learning routes/services and Speaking activity contract
- Voice Tutor recovery/capsule integration
- Speaking report UI
- adaptive, entitlement, Voice Tutor, retention and frontend tests

## Definition of Done

- [x] Валидная попытка публикует отдельные speaking skills, а техническая/подсказанная не повышает mastery.
- [x] План выбирает слабый критерий и проверяет его на новом материале.
- [x] Base всегда видит полный разбор текущей попытки и 60 минут оценки.
- [x] Premium получает 240 минут, динамику, сравнение, targeted practice и Voice Tutor.
- [x] Voice Tutor использует bounded error context и не переписывает официальный результат.
- [x] При максимуме всех критериев Voice Tutor использует точную server-owned ошибку слова/фонемы,
  если её надёжная acoustic-оценка ниже 80; criterion-loss сохраняет приоритет.
- [x] Create, exact replay, realtime-ticket и fallback recovery после owner lock повторно проверяют Base+Premium
  и заново валидируют pronunciation pointer по текущей попытке; revoke/assistance/ref drift/expiry не вращают credentials.
- [x] Целевые тесты, `npm run lint`, `npm run check`, `npm test` проходят.
- [ ] Один коммит на тикет.

## Pre-review checkpoint — 2026-08-07

Готовы owner-bound evidence для 11 Speaking-навыков внутри общей таксономии из 21 навыка, monotonic invalidation mastery после поздней
подсказки, целевой adaptive launch на новом server-owned материале, Base/Premium report и bounded
Voice Tutor handoff. Отдельные позитивные word/phoneme-агрегаты и fluency заданий 1–4 не выводятся
из отсутствия ошибки; грамматика и лексика задания 4 разделяются только по validated semantic kinds.
PostgreSQL bind блокирует сессию и попытку в одном порядке и повторно проверяет provenance до
consumption claim.

Целевой Speaking-контур проходит 25/25; полный `npm test` — 1148 total (1125 pass,
23 штатных PostgreSQL skip, 0 fail). `npm run lint`, `npm run check`, frontend build, адаптивный и
полный Chromium E2E, secret/history scans и `git diff --check` проходят. Disposable PostgreSQL
применила миграции 001–050 и прошла 23/23, затем ресурсы удалены. Платных/provider-вызовов, push и
deploy не было. Остались два последовательных независимых Standards/Spec review, нулевые re-review,
финальный metadata checkpoint и единственный локальный commit.

## Freeze checkpoint — 2026-08-07

После pre-review закрыты переход сохранённого плана с таксономии `ege-en-v1` на `ege-en-v2`,
коммерческая проверка Premium, стабильная идентичность фонетических целей, Base-история и публичные
границы отчёта. Выдача targeted practice теперь атомарно сверяет актуальный Premium, последнюю
оценённую попытку и отсутствие помощи; конкурирующие новая попытка или помощь делают старый указатель
устаревшим и возвращают `409` одинаково в файловом и PostgreSQL-хранилищах.

Финальное укрепление после review связывает все 11 Speaking micro-activities через проверенное семейство
номера задания, сегментирует цели/результаты/динамику по `accentLocale`, применяет фонетические события
хронологически и реактивирует цель после более позднего регресса. Указатель targeted practice содержит
`reportRevision`, поэтому любая новая оценённая попытка делает его устаревшим; assisted, technical и
low-confidence попытки публикуют только `inconclusive` outcome. Base не запускает Premium mining, а
Premium использует прединдексированный каталог и жёсткие пределы 120/480/240/20. Поздняя помощь не может
сохранить устаревший адаптивный профиль: file owner queue и PostgreSQL owner transaction сравнивают
детерминированный evidence fingerprint до записи.

Полный `npm test` — 1181 total (1154 pass, 27 штатных PostgreSQL skip, 0 fail); отдельный disposable
PostgreSQL-контур применил миграции 001–050 и прошёл 27/27, затем ресурсы удалены. `npm run lint`,
`npm run check`, frontend build, `git diff --check`, adaptive/full Speaking/pronunciation Chromium E2E и
secret/history scans прошли повторно. Платных/provider-вызовов, push и deploy не было. Код заморожен для
последовательных Standards/Spec review, нулевого re-review и одного локального коммита владельцем
родительской задачи.

## Final concurrency and locale hardening — 2026-08-07

Связывание Speaking-блока теперь требует не только правильный номер задания, но и evidence ровно для
назначенного `skillId`; word/phoneme focus дополнительно требует точный не-`inconclusive` target outcome.
Обе реализации хранилища используют один общий валидатор для всех 11 микронавыков. Цели критериев,
сравнение попыток, динамика критериев/беглости/пауз, общий тренд и рекомендация времени разделены по
`accentLocale`: данные `en-GB` никогда не закрывают и не сравниваются с `en-US`.

Все источники adaptive evidence сериализуются с сохранением профиля: file-хранилище использует общий
owner mutation queue, PostgreSQL — транзакцию с user `FOR UPDATE` до дочерних строк. Это относится к
module attempts, Writing/Speaking completion, diagnostic responses/completion и Voice Tutor recovery/repeat.
Выдача целевого Speaking-задания и обновление/отзыв Premium используют ту же границу; после завершённого
отзыва новая Premium-сессия не появляется.

Финальная регрессия: 95/95 целевых тестов, полный `npm test` — 1187 total (1159 pass, 28 штатных
PostgreSQL skip, 0 fail), disposable PostgreSQL с миграциями 001–050 — 28/28. `npm run lint`,
`npm run check`, frontend build (482 проверенных assets), adaptive/full Speaking/pronunciation Chromium
E2E, secret/history scans и `git diff --check` прошли. Disposable container/network/volume удалены;
provider-вызовов, push и deploy не было.

## Nullable acoustics and active-profile freeze — 2026-08-07

Финальная проверка устранила две ложные интерпретации данных. Отсутствующие, строковые, бесконечные и
вне диапазона акустические показатели больше не проходят через `Number(...)` как ноль: единый строгий
контракт сохраняет `null` в provider projection, сохранённом review, словах/фонемах, отчёте и adaptive
evidence. Если доступных агрегатов нет, среднее равно `null`; такие данные не создают mastery,
фонетическую цель или искусственную динамику 0%. При этом высоконадежная семантическая попытка остаётся
оценённой, если Azure сообщил факт негрубого `mispronunciation`, но не прислал числовую точность.

Premium-отчёт теперь читает текущий канонический профиль произношения и ограничивает target mining,
ранжирование, сравнение, динамику и распределение времени его `en-GB` либо `en-US`. Та же локаль входит
в публичную основу отчёта и adaptive metadata. File и PostgreSQL assignment повторно читают профиль
внутри owner-serialized mutation/transaction и возвращают `409`, если локаль указателя цели уже не
совпадает с канонической; поэтому после ручного `en-GB → en-US` старая цель не может создать заведомо
несопоставимую сессию.

Финальные проверки: nullable/accent focused-контур вместе с UI — 58/58; полный `npm test` — 1190 total
(1162 pass, 28 штатных PostgreSQL skip, 0 fail). Disposable PostgreSQL применил миграции 001–050 и
прошёл 28/28, затем container/network/volume были удалены. `npm run lint`, `npm run check`, frontend
build (482 assets), отдельный HTTP smoke, adaptive/full Speaking/pronunciation Chromium E2E,
secret/history scans и `git diff --check` прошли. Provider-вызовов, push и deploy не было. Код готов к
повторному последовательному Standards/Spec review и единственному коммиту владельцем родительской задачи.

## Atomic report and provider-event freeze — 2026-08-07

Последний review закрыл четыре границы. Azure принимает confidence/offset/duration только как конечные
числа JavaScript в допустимом диапазоне: `null`, пустые и числовые строки не превращаются в ноль или
успешную беглость. События `unexpected_break`/`missing_break` сохраняются отдельно от ошибок
произношения, видны в Base и образуют хронологическую Premium-динамику, но не влияют на балл ФИПИ.

Learning report получает попытки, квоту/тариф и канонический акцент одним owner-serialized снимком:
общая очередь в file repository и одна PostgreSQL-транзакция с user `FOR UPDATE`. Детерминированные
гонки подтверждают, что смена акцента, поздняя помощь и отзыв Premium никогда не смешивают состояния
одного ответа. Voice Tutor получает server-owned bounded criterion и matching attempt summary; более
новая technical/assisted попытка не может скрыть или неверно подписать надёжную старую ошибку, а UI не
берёт подпись из `currentAttempt`.

Финальные проверки после этих изменений: focused Speaking/UI 84/84; полный `npm test` — 1195 total
(1167 pass, 28 штатных PostgreSQL skip, 0 fail); disposable PostgreSQL применил 001–050 и прошёл 28/28,
включая новую owner-lock гонку, после чего container/network/volume удалены. `lint`, `check`, frontend
build (482 assets), полный Chromium E2E, adaptive Chromium E2E, оба secret scan и `git diff --check`
зелёные. Реальных provider-вызовов, push и deploy не было. Остались последовательный Standards/Spec
re-review и один локальный коммит владельцем родительской задачи.

## Base subscription authority after route precheck — 2026-08-08

Final16 разделил два разных исхода авторизации Speaking learning loop. Learning-report snapshot и
Premium targeted assignment теперь после file owner queue либо PostgreSQL user `FOR UPDATE` получают
свежее authority-время и сначала проверяют всю базовую подписку (`subscription_until > effectiveNow`).
Если Base истёк после успешного route-precheck, repository возвращает `SUBSCRIPTION_REQUIRED`, HTTP
отвечает 403 без данных отчёта, а targeted mutation не создаёт сессию. Только после этой проверки
определяется Base/Premium: отзыв одного `voice_tutor` при ещё активной Base-подписке сохраняет обычный
отчёт и даёт прежний 409 для устаревшего Premium-указателя; активный Premium продолжает работать.

TDD RED зафиксировал оба публичных file-исхода: learning report был 200 вместо 403 (0/1), targeted
assignment — 409 вместо 403 (0/1). После реализации file API прошёл 11/11. Живой PostgreSQL отдельно
воспроизвёл обе гонки с expiry, закоммиченным перед освобождением owner lock: report сначала не
отклонял запрос, targeted path возвращал `SPEAKING_TARGETED_PRACTICE_STALE`; итоговый disposable-набор
применил миграции 001–052 и прошёл 37/37, включая неизменившийся счётчик targeted sessions.

Полный `npm test` — 1237 total (1200 pass, 37 штатных PostgreSQL skip, 0 fail); `lint`, `check`
(348 JavaScript-файлов), frontend build (482 assets), полный и adaptive Chromium E2E зелёные. Реальных
provider/платных вызовов, commit, push и deploy не было. Дерево передано на свежие последовательные
Standards → Spec review.

## Post-lock report, claim clock and bounded evidence hardening — 2026-08-08

Final15 закрывает три оставшиеся authority/performance границы. Speaking learning report и targeted assignment
теперь определяют действующий entitlement только после file owner queue или PostgreSQL user `FOR UPDATE`; отзыв
или expiry, завершившийся во время ожидания, даёт Base-проекцию либо 403 без создания целевой сессии.

Adaptive execution claim получает `issued_at` и фиксированный двухчасовой `expires_at` из свежего времени после
той же блокировки, а start response/replay сохраняет именно locked server snapshot. Exact replay, module attempt,
server-owned Writing/Speaking bind, Voice Tutor repeat и advance повторно проверяют expiry по post-lock времени;
запрос, начатый до expiry, не может записать evidence после expiry, и задержанный start не возвращает уже истёкший
claim. File-race тесты используют управляемую authority clock, PostgreSQL тесты проверяют сохранённый fixed TTL и
коммитят expiry до следующей locked mutation.

Adaptive Speaking evidence ограничен 120 новейшими owner-bound `completed|needs_retry` попытками до hydration и
hash: порядок `COALESCE(evaluated_at, created_at) DESC, id DESC`, file slice до mapping, PostgreSQL `ORDER BY/LIMIT`
до `jsonb_agg`. Компактная проекция не читает transcript/assignment/provider, а доменный mapper повторяет cap
защитно до разворачивания одной попытки в несколько skill observations. Старые попытки не удаляются и продолжают
входить в owner export; миграция не нужна.

TDD evidence RED: 1/1 targeted fail (`125 !== 120`), затем unit/file GREEN 1/1 + 1/1. Живой disposable
PostgreSQL применил миграции 001–052 и прошёл 35/35, включая новый evidence bound и все TTL bind-пути. Полные
локальные gates после последней правки зелёные: focused 107/107, полный `npm test` — 1233 total
(1198 pass, 35 штатных PostgreSQL skip, 0 fail), lint, check 348 JavaScript files, frontend build 482 assets,
полный и adaptive Chromium E2E, secret/history scans и `git diff --check`. Disposable PostgreSQL resources
удалены; реальных provider/платных вызовов, commit, push и deploy не было. Дерево передано на свежие
последовательные Standards → Spec review.

## Entitlement, monotone and bounded-plan final freeze — 2026-08-08

Финальный повторный аудит закрыл три конкурентные границы. Для Premium-depth Writing/Speaking
операции `start`, `bind-attempt` и `advance` повторно читают активную базовую подписку и
`voice_tutor` entitlement внутри той же owner queue в file storage или PostgreSQL-транзакции с user
`FOR UPDATE`, до replay и до любой записи. Поэтому отзыв Premium, завершившийся после route-precheck,
линейно побеждает новый запуск, точный start replay, привязку попытки и advance; Basic-блоки продолжают
работать без Premium. Детерминированные HTTP hooks проверяют все три interleaving в file и живом
PostgreSQL.

Azure-аннотация `monotone` остаётся распознанным произнесённым словом для completeness, spoken time и
fluency, сохраняется как отдельное видимое provider event, но не входит в набор ошибок ФИПИ. Задание 1
получает тот же балл с `monotone` и без него. Все исчерпанные plan-stage гонки — save conflict, goal
mismatch, `ADAPTIVE_PLAN_GOAL_STALE`, `ADAPTIVE_PLAN_PROFILE_STALE`,
`ADAPTIVE_PLAN_EVIDENCE_STALE` и recalculation conflict — после трёх полных overview-попыток отвечают
одинаково: retryable `409 ADAPTIVE_PROFILE_RETRY_REQUIRED` и `Retry-After: 1`; первая или вторая
временная гонка по-прежнему возвращает согласованный `200`.

Проверки: focused RED был 85 total / 80 pass / 5 ожидаемых fail, после реализации — 85/85. Полный
`npm test` — 1219 total (1185 pass, 34 штатных PostgreSQL skip, 0 fail); disposable PostgreSQL применил
миграции 001–052 и прошёл 34/34, после чего container/network/volume удалены. `lint`, `check` (348 JS),
frontend build (482 assets), полный и adaptive Chromium E2E, secret scan 1082 tracked файлов, history
scan 298 commits и `git diff --check` зелёные. Реальных provider/платных вызовов, commit, push и deploy
не было. Дерево заморожено для свежих Standards → Spec review и единого коммита владельцем
родительской задачи.

## Locked execution authority final freeze — 2026-08-08

Final14 закрыл ещё три owner-serialized границы. Premium-depth entitlement теперь оценивается по
effective time, полученному только после file queue или PostgreSQL user `FOR UPDATE`; PostgreSQL берёт
`clock_timestamp()`, а request `candidate.now` больше не является authority. Детерминированный отзыв с
timestamp строго позже request t0 блокирует fresh start, exact replay, bind и advance, а активный
entitlement сохраняет положительный путь.

Старт до записи claim сверяет owner-locked session revision/replacement и точный launch fingerprint с
ответом, прочитанным route. Если замена победила до start lock, клиент получает 409, а не старый launch с
claim нового блока. Замена разрешена только до исполнения: любой pending/local start, claim (включая
expired/consumed), `started_at`, `in_progress`/`completed`, положительная execution revision или event
закрывает и новый запрос, и exact replay кодом `409 ADAPTIVE_SESSION_REPLACEMENT_LOCKED`; UI убирает
контролы немедленно при локальном start pending.

TDD RED: effective-time file 5/6, stale-launch 6/7, replacement/UI 20/23. GREEN: file/API/runtime 23/23;
полный `npm test` — 1223 total (1189 pass, 34 штатных PostgreSQL skip, 0 fail); disposable PostgreSQL
применил 001–052 и прошёл 34/34, после чего container/network/volume удалены. Provider-вызовов, commit,
push и deploy не было. `lint`, `check` (348 JS), frontend build (482 assets), полный и adaptive Chromium
E2E, secret scan 1082 tracked файлов, history scan 298 commits, отдельный scan 7 untracked файлов и
`git diff --check` зелёные; Docker Desktop возвращён в остановленное исходное состояние. Дерево
заморожено для свежих последовательных Standards → Spec review.

## Strict evidence types and bounded profile retry freeze — 2026-08-07

Повторный аудит закрыл две последние fail-closed границы adaptive overview. `score` и `max_score`
считаются evidence только как настоящие конечные числа с положительным максимумом; diagnostic и
recovery-флаги — только как настоящие boolean. `null`, пустые значения, числовые и boolean-похожие
строки больше не преобразуются и не меняют mastery, source count, latest timestamp или fingerprint.
File reader сохраняет raw legacy-поля до общей проекции, а PostgreSQL допускает Writing JSON к cast
только после `jsonb_typeof(...)= 'number'`; прямые corrupted-JSON регрессии подтверждают parity.

Profile CAS ограничен тремя полными попытками независимо от наличия цели и включённого plan rollout.
Первая или вторая временная гонка возвращает один свежий согласованный snapshot; после третьей route
fail-closed отвечает `409 ADAPTIVE_PROFILE_RETRY_REQUIRED`, `retryable: true` и `Retry-After: 1`, не
подставляя старый профиль к новой retention/access-проекции. Проверки: focused adaptive/file 124/124;
полный `npm test` — 1215 total (1183 pass, 32 штатных PostgreSQL skip, 0 fail); disposable PostgreSQL
применил миграции 001–052 и прошёл 32/32; `lint`, `check`, frontend build 482 assets, полный и adaptive
Chromium E2E, secret scan 1082 tracked файлов, history scan 298 commits, отдельный scan 7 untracked
файлов и `git diff --check` зелёные. Временные PostgreSQL-ресурсы удалены; provider-вызовов, push и
deploy не было. Код заморожен для свежих последовательных Standards → Spec review.

## Canonical evidence vector and plan interleaving freeze — 2026-08-07

Финальный аудит закрыл гонку между сохранением evidence-профиля и персонального плана. Одна
каноническая проекция допустимых источников теперь одновременно производит calculation revision,
watermark version, source count, observedAt и SHA-256 fingerprint. Исключённые client-reported
Writing/Speaking, неподдерживаемые diagnostics и другие неучитываемые строки не могут изменить ни
одну часть watermark. Известные timestamps приводятся к одной ISO-форме из `Date`, ISO, epoch
milliseconds и epoch seconds, поэтому одинаковое file/PostgreSQL evidence получает один fingerprint.

`saveAdaptiveLearningPlan` внутри file owner queue или PostgreSQL owner-lock transaction перечитывает
текущие evidence sources и до duplicate replay/insert сверяет с ними полный вектор persisted profile и
candidate. При `ADAPTIVE_PLAN_EVIDENCE_STALE` route ограниченно повторяет весь overview: снова читает
evidence, сохраняет профиль, строит и сохраняет план. Детерминированный hook после profile save и до
plan save подтверждает в file и живом PostgreSQL, что поздняя помощь даёт один согласованный HTTP 200
с пониженным профилем и новой ревизией плана, а устаревший план не становится current.

Проверки: focused diagnostic/adaptive/plan/file 111/111; полный `npm test` — 1209 total (1179 pass,
30 штатных PostgreSQL skip, 0 fail); disposable PostgreSQL применил миграции 001–052 и прошёл 30/30.
`lint`, `check`, frontend build (482 assets), полный и adaptive Chromium E2E, secret scan 1082 файлов,
history scan 298 commits и `git diff --check` зелёные. Временные PostgreSQL container/network/volume
удалены. Реальных provider/платных вызовов, push и deploy не было. Дерево заморожено для свежих
Standards → Spec review и одного локального коммита владельцем родительской задачи.

## Adaptive plan evidence fingerprint freeze — 2026-08-07

Миграция `052_adaptive_plan_evidence_fingerprint.sql` проводит канонический SHA-256 fingerprint точного
снимка evidence профиля через входной fingerprint плана, внешний persistence-вектор, встроенную семантику
плана, public DTO, file/PostgreSQL storage и пользовательский export. Старые ревизии с `null` остаются
читаемыми. При одинаковых source count и observedAt поздняя отметка помощи теперь сравнивается по
содержимому, понижает independent mastery и создаёт новую согласованную ревизию плана; старый план не
может вернуться ни как current, ни как ошибочный replay.

TDD-проверка проходит через настоящий HTTP API одинаково для file и PostgreSQL: профиль меняет
fingerprint при неизменных count/time, план получает новый id/revision/fingerprint и пересчитанное
распределение. Export содержит обе ревизии, account deletion удаляет историю, а file и PostgreSQL legacy
планы без fingerprint корректно обновляются. Проверки: focused file 72/72; полный `npm test` — 1205 total
(1175 pass, 30 штатных PostgreSQL skip, 0 fail); disposable PostgreSQL применил миграции 001–052 и
прошёл 30/30, после чего container/network/volume удалены. `lint`, `check`, frontend build (482 assets),
полный и adaptive Chromium E2E, secret scan 1082 файлов, history scan 298 commits и `git diff --check`
зелёные. Реальных provider/платных вызовов, push и deploy не было. Код снова заморожен для Standards →
Spec review и одного локального коммита владельцем родительской задачи.

## Final evidence fingerprint and provider capability checkpoint — 2026-08-07

Последний повторный аудит закрыл три fail-closed границы. Любое финальное событие Azure continuous
recognition с причиной, отличной от `RecognizedSpeech` (включая смешанный valid + `NoMatch` поток),
делает покрытие неполным и не может дать успешную официальную оценку. `pauseAnalysisAvailable` и
`prosody.available` становятся true только для `en-US`, когда SDK действительно предоставляет
`enableProsodyAssessment()` и вызов завершается успешно; отсутствие метода или исключение дают честный
`provider_pause_metric_unavailable`, а поддерживаемый нулевой результат остаётся доступным значением 0.

Миграция `051_adaptive_profile_evidence_fingerprint.sql` сохраняет канонический SHA-256 содержимого
evidence в профиле, DTO, public projection и экспорте. Legacy-строки с null продолжают читаться. Если
revision, count и timestamp совпадают, но помощь изменила содержимое evidence, owner-serialized CAS
сверяет кандидат с текущими источниками: assisted-профиль понижает устаревшее independent mastery, а
обратная запись старого снимка отклоняется и в file, и в PostgreSQL.

Проверки: focused 117/117; полный `npm test` — 1203 total (1174 pass, 29 штатных PostgreSQL skip,
0 fail); disposable PostgreSQL применил миграции 001–051 и прошёл 29/29, включая legacy-null,
same-time assistance downgrade, stale replay, export и delete. `npm run lint`, `npm run check`, frontend
build (482 assets), полный и adaptive Chromium E2E, оба secret scan и `git diff --check` прошли.
Временные PostgreSQL container/network/volume удалены; реальных provider/платных вызовов, push и deploy
не было. Дерево заморожено для последовательных Standards и Spec review.

## Complete Azure evidence freeze — 2026-08-07

Последняя проверка закрыла ещё четыре связанные границы. Неполный continuous-ответ Azure — потерянный
`NBest`, confidence, обязательный факт слова, лишний сегмент или 501-е слово до публичного ограничения —
теперь всегда `low_quality/needs_retry` и не участвует в mastery. Offset, duration и их сумма сверяются
со строго разобранной длительностью WAV с явным допуском 50 мс; невозможная временная отметка
обнуляет акустические агрегаты до ФИПИ и не публикуется как достоверное время.

`unexpected_break` и `missing_break` остаются распознанными словами для accuracy, completeness и
fluency, но не входят в число ошибок ФИПИ: один и тот же ответ получает один балл с pause-аннотациями
и без них. Возможность анализа пауз теперь передаётся отдельным `pauseAnalysisAvailable` от provider
через сохранённый review, Base/Premium report, OpenAPI и UI. Для `en-US` ноль событий честно означает
доступный анализ с нулевым счётчиком; для неподдерживаемого `en-GB` — недоступный показатель, поэтому
Premium-динамика может улучшаться до настоящего нуля.

Проверки: focused provider/evaluation/FIPI/learning/UI — 84/84; полный `npm test` — 1200 total
(1172 pass, 28 штатных PostgreSQL skip, 0 fail); disposable PostgreSQL применил миграции 001–050 и
прошёл 28/28, после чего container/network/volume удалены. `lint`, `check`, frontend build (482 assets),
полный Chromium E2E, дополнительный adaptive Chromium E2E, оба secret scan и `git diff --check`
зелёные. Реальных provider-вызовов, push и deploy не было. Остались последовательный Standards/Spec
re-review и один локальный коммит владельцем родительской задачи.
