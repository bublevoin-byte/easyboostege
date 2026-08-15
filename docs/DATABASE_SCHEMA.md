# Схема базы данных

## Grammar 2.0 mastery persistence

Grammar has no separate PostgreSQL table: file and PostgreSQL repositories store the canonical map
under `user_progress.data.grammarMastery`, while explicitly stripping the device-only
`grammarRunner` key. Each record carries its revision, stage/review state, bounded stats and mastery
history. The repository's existing owner transaction, compare-and-set expectations and event UUID
give exact replay idempotency in both backends.

An `exam_19_24` completion is expanded atomically over the ordered `topicExpectations` in one owner
transaction. All per-topic history rows retain the same event/session identity; exact replay changes
nothing, while a changed payload under that UUID conflicts. Correct exam outcomes and all generated
outcomes are history only. A wrong immutable built-in gap may regress only its catalog-owned physical
topic. Prompts, answer strings and the resumable browser snapshot are not written to the database.

## Speaking pronunciation quota ledger and evaluation replay (`046`–`048`)

`speaking_pronunciation_assessments` is the authoritative monthly seconds ledger. Each row is owner-bound and unique by `(username, idempotency_key)`, with `period_start`, locale, nullable bounded server-owned `context_id`, reservation/finalization state, reserved and billable seconds, bounded normalized result JSON, release reason, and timestamps. Migration `047` adds and bounds `context_id`; official requests use `taskN:<session UUID>:<task id>@<revision>` and tasks 2–3 append `:itemN`, so a saved assessment cannot be attached to another task or position. Database checks enforce `billable_seconds <= reserved_seconds` and the legal `reserved -> dispatching -> started -> finalized`, explicit pre-start `reserved|dispatching -> released`, and conservative stale-`dispatching -> finalized` shapes. `dispatch_started_at` is written atomically before provider code is entered; `provider_started_at` retains the narrower meaning that the SDK start callback actually fired. Released rows retain only their bounded canonical outcome so an exact retry cannot change status or reason. Under the owner lock, quota/replay/reserve operations reconcile the five-minute nonterminal lease: an expired reservation releases zero seconds, while expired dispatching or started rows finalize the full reservation conservatively. The owner foreign key uses `ON DELETE CASCADE`; the file repository implements the same contract atomically.

Migration `048` adds a bounded SHA-256 `evaluation_fingerprint`, `evaluation_claimed_at`, a non-negative `evaluation_claim_generation`, and a partial unique index on `(username, evaluation_fingerprint)` to `speaking_attempts`. File and PostgreSQL repositories atomically claim the same owner-bound attempt, so an identical official evaluation replays its canonical completed, retry or terminal failed result without a second xAI call. A five-minute claim lease lets exactly one caller recover a process-interrupted `pending` attempt; each recovery advances the generation, and a terminal write must compare-and-set the same pending generation so a stale worker cannot overwrite its successor. Transient `AI_NOT_CONFIGURED` and `AI_PROVIDER_UNAVAILABLE` failures can resume the same attempt and reuse the already finalized Azure evidence, while invalid model output remains a terminal canonical replay. New provider-bound claims are created only after budget/rate admission. The fingerprint, lease timestamp, and generation are internal and do not replace owner checks on catalog sessions or pronunciation assessments.

Источником истины являются SQL-файлы в `migrations/`.

| Таблица | Назначение | Ключевые данные |
|---|---|---|
| `schema_migrations` | применённые миграции | `version`, `applied_at` |
| `users` | аккаунты Telegram/legacy и роли | `username`, `telegram_id`, `role`, subscription fields |
| `sessions` | серверные пользовательские сессии | `id`, `username`, expiry, revoke timestamp |
| `subscriptions` | текущее состояние доступа | `username`, status, source, start/end timestamps |
| `subscription_events` | неизменяемая история выдачи и изменения тарифа | username, event type, bounded metadata and timestamp |
| `subscription_entitlements` | отдельные тарифные права Premium | `username`, entitlement, start/end timestamps |
| `adaptive_learning_goals` | история целей ЕГЭ с одной текущей ревизией | target score, exam date, weekly minutes, revision, bounded idempotency fields and created/updated timestamps |
| `adaptive_learning_profiles` | версия и уверенность объяснимого профиля ученика | taxonomy/weighting/watermark versions, monotonic calculation revision, latest source timestamp/count plus canonical evidence fingerprint, preliminary/status flags, confidence, independent/assisted/client-reported counts, established skill count and reason codes |
| `adaptive_learning_skill_estimates` | структурированные оценки микроскиллов без копий ответов | skill/module, mastery, uncertainty, raw/effective/independent counts, evidence quality, per-skill status, due state, server-derived critical retention expiry and explanation code |
| `adaptive_learning_plan_revisions` | owner-bound история объяснимых прогнозов и недельных распределений | exact base/goal/profile revisions, evidence watermark/count/content fingerprint, UTC daily calculation bucket, bounded forecast/allocation/stability JSON, internal input fingerprint and current marker; deterministic `calculatedAt` is derived as bucket start while `created_at`/`updated_at` remain receipt timestamps; duplicate replay additionally requires an exact normalized outer-vector and plan-semantic match, ignoring only regenerated ID and receipt timestamps |
| `adaptive_learning_sessions` | исполнимые owner-bound занятия и их коммерческий scope | неизменяемая ревизия плана, 15–120 минут, server-owned blocks/launch, status/completion summary и `commercial_scope=free_demo|base|premium`; legacy rows считаются `base` |
| `adaptive_diagnostic_sessions` | ограниченный по времени запуск короткой или Premium deep адаптивной диагностики | owner, UUID, версия server-owned catalog-policy, статус/current item/счётчики/timestamps и внутренний allowlisted `completion_response_snapshot`, атомарно связанный с completion key/hash; без prompt и answer key |
| `adaptive_diagnostic_start_claims` | immutable start claim для каждого успешного owner-bound idempotency key | request hash, точный снимок возвращённой session state и `claim_expires_at`; окно 24 часа и максимум 16 живых claims на владельца, внутренние key/hash не экспортируются |
| `adaptive_diagnostic_responses` | проверенные сервером ответы диагностики с явным уровнем доверия | session/item/skill/module IDs, `evidence_quality`, choice/correct/time и внутренний allowlisted replay snapshot (`replay_status` и остальные безопасные поля состояния); без prompt, answer key, audio и transcript |
| `voice_tutor_sessions` | голосовая квота и структурированный ход разбора без аудио и полного transcript | minimized capsule reference, delivery/state/outcome, discovery claim, clarification/micro-check counters, reserved/billable seconds and timestamps |
| `voice_tutor_recoveries` | server-validated результат педагогического FSM по навыку | session/skill/rule ids, bounded state flags, module, potential-points mapping and timestamp; no learner text |
| `voice_tutor_repeats` | server-owned интервалы переноса навыка | distinct task id, UTC day-1/day-7 due/window and supersession state |
| `voice_tutor_repeat_attempts` | одна проверенная попытка нового аналога | opaque attempt/repeat/task ids, pass flag, idempotency hash and timestamp; no submitted answer |
| `trusted_rule_cards` | очередь найденных правил и проверенный canonical слой | bounded rule, skill/exam year, source URL/content hashes, status, discrepancies and review audit; полных страниц нет |
| `voice_tutor_reports` | структурированная очередь сообщений ученика | owner/session/rule IDs, enum reason/status, timestamps and review audit; no learner text/audio/transcript |
| `payment_requests` | ручные заявки на базовый или Premium Voice тариф | product, status, administrator, result and resolution time |
| `user_progress` | JSONB-прогресс пользователя | `username`, `data`, `updated_at` |
| `telegram_auth_codes` | одноразовые коды входа | hash кода, expiry, consumed state |
| `writing_attempts` | журнал пользовательских прогонов заданий 37/38 | assignment, answer, evaluated_answer, review, provider, model, prompt_version, status, error_code |
| `speaking_attempts` | журнал пользовательских прогонов устной части | server-owned assignment, transcript, strict semantic facts, deterministic criteria/score, confidence/retry reason, scoring/prompt/provider/model versions and bounded normalized acoustic facts for official tasks 1–4 needed to re-check the stored score; audio and raw provider payload are not stored |
| `speaking_task1_sessions` | owner-bound тренировки чтения вслух | catalog/task revision, rotation reason, status, duration, mic check, local-playback flag, self-rating и timestamps; без audio/transcript |
| `speaking_task2_sessions` | owner-bound последовательные тренировки четырёх вопросов | catalog/task revision, current question, четыре безопасные metadata-позиции, self-rating и timestamps; без audio/transcript/score |
| `speaking_task3_sessions` | owner-bound последовательные тренировки пяти ответов | catalog/task revision, current question, пять безопасных metadata-позиций, self-rating и timestamps; без audio/transcript/score |
| `speaking_task4_sessions` | owner-bound тренировки проектного монолога по фотопаре | catalog/task revision, rotation reason, status, длительность до 180 секунд, mic check, local-playback flag, self-rating и timestamps; фотопара хранится в versioned static catalog, audio/transcript/score отсутствуют |
| `speaking_full_sessions` | owner-bound полный устный раздел ЕГЭ | pinned format/catalog/task revisions для четырёх заданий, вариант 0–59, фаза и server deadlines, 11 bounded response metadata, canonical idempotent submission и максимум 20; несовместимая активная ревизия атомарно получает `abandoned` перед безопасной заменой, просроченный ответ — `response_timeout`; audio/transcript/answer/rubric/score отсутствуют |
| `generated_tasks` | валидированные результаты генерации | operation, versioned request hash, request/result and provider |
| `module_attempts` | нормализованная история учебных результатов и единственный persisted source Reading-отчёта | module, activity, score, duration, bounded metadata and server-owned `evidence_quality`; legacy/public writes are `client_reported`; Reading projection принимает только owner-bound canonical catalog ID/revision/provenance и завершённые логические попытки |
| `progress_summary` | серверная агрегированная сводка прогресса | attempts, best normalized score, total duration and last attempt |
| `word_progress` | версионированное многомерное освоение слов с совместимым SRS | word, legacy stage/errors/reviews/due time, meaning/spelling/context/listening dimensions, evidence provenance and last answer mode/outcome |
| `error_bank` | агрегированный банк учебных ошибок | module, item key, type, bounded details and occurrence count |
| `audit_log` | неизменяемый журнал административных действий | actor, action, target, result and bounded metadata |
| `ai_requests` | технический журнал ИИ и durable paid-operation slots | operation, claim key/state, nullable exact-context SHA-256 fingerprint, provider, model, duration, status, error code, tokens, estimated cost |

File and PostgreSQL account export project `ai_requests` through one shared snake-case allowlist:
`id`, `operation`, `provider`, `model`, `prompt_version`, `context_fingerprint`, `status`, `duration_ms`,
`error_code`, `prompt_tokens`, `completion_tokens`, `estimated_cost_microusd`, `created_at`. Internal owner and
reservation authority (`username`, `claim_key`) are never exported, and no camel-case backend fallback is part of
the public export contract.

Связи привязаны к `users.username`; API всегда определяет пользователя из HttpOnly-сессии. Изменения схемы добавляются новой нумерованной миграцией и проверяются `npm run db:migrate`.

Миграция `040_word_mastery.sql` сохраняет прежние `stage`, счётчики и срок повторения, но добавляет
`mastery_version=1` и четыре измерения. Старые оценки переносятся только как `preliminary`, с нулём
независимых успехов, поэтому даже legacy stage 5 не становится состоянием Strong. File storage
выполняет тот же идемпотентный mapper при первом чтении. `/api/v1/word-progress` принимает старый
payload и строгий v1 payload, а GET, file/PostgreSQL persistence и account export используют одну
owner-scoped DTO-проекцию без `username` и backend-only полей; удаление остаётся каскадным/полным.
Изоморфный доменный модуль намеренно находится в `public/`: браузер импортирует его для
офлайн-снимка, а validation/storage на сервере — для той же нормализации и мягкого merge старого
payload без второй реализации алгоритма.

Миграция `031_adaptive_learning_goal_profile.sql` хранит только цель и производные структурированные оценки. Профиль пересчитывается из owner-bound `module_attempts` и проверенных Voice Tutor recovery/repeat записей; тексты ответов, эссе, transcript и audio в adaptive-таблицы не копируются. Клиентский `/module-attempts` не может назначить доверенное происхождение: такие и все прежние строки считаются `client_reported`, дают только слабую предварительную подсказку и не подтверждают mastery. Для расчёта одного навыка учитываются все независимые наблюдения, но не более трёх последних `client_reported` и трёх assisted-наблюдений; без независимого подтверждения mastery ограничен 49, а uncertainty не уменьшается. Навык получает `established` только после двух независимых unassisted/retention наблюдений. Весь профиль получает `established`, только когда подтверждены все 21 навык, набрано минимум 12 независимых наблюдений минимум в трёх модулях и пройдены общие пороги покрытия/уверенности. Активности сопоставляются с версионированной таксономией только по точным ID/alias; неизвестная обычная активность получает явный fallback своего модуля, а неизвестная агрегатная `exam`-активность игнорируется. Служебные `voice_tutor_*` module attempts не становятся adaptive-наблюдениями: конкретный навык учитывается только из recovery/repeat ledger и поэтому не дублируется в module default. Эти три профильные adaptive-таблицы входят в экспорт владельца и каскадно удаляются вместе с `users`.

Миграция `032_adaptive_short_diagnostic.sql` добавляет owner-bound сессии, immutable start claims и ответы короткой диагностики. Server-owned registry хранит catalog и policy парой и сохраняет `ege-short-diagnostic-v1` как самостоятельную версию: чтение, браузерные лимиты, прогресс, выбор следующего задания, остановка, expiry и итоговый профиль всегда используют `session.catalog_version`, а неизвестная сохранённая версия закрывается ошибкой без подстановки текущих mappings и не получает evidence. Принятые ответы приватно уточняют выбор следующего probe, но не становятся profile evidence до успешного завершения. Каждый успешный start key получает точный снимок сессии, включая key, возобновивший active run; claim живёт не более 24 часов, ограничен 16 живыми claims на владельца и очищается при последующих стартах. Отдельный hourly rate limit применяется до дорогого расчёта overview. Answer idempotency хранит только allowlisted безопасный replay snapshot (`replay_catalog_version`, `replay_status`, `replay_current_item_id`, счётчики, stop reason и timestamps), поэтому повтор возвращает ровно первоначально увиденное состояние даже после следующих ответов или completion. Первый completion в одной mutation сохраняет status/key/hash и `completion_response_snapshot`: только публичный diagnostic DTO, bounded result и allowlisted preliminary profile. Повтор исходного key и другой completion key возвращают этот canonical snapshot до живого пересчёта; отсутствие/повреждение снимка закрывается ошибкой, а конкурентный кандидат не перезаписывает победителя. Claim key/hash и внутренние replay snapshots не экспортируются. Клиент получает безопасную проекцию без answer key и skill mapping и отправляет только `itemId`/`choiceId`. Поля `estimatedMinutes`, `deadlineMinutes`, `maxItems` и `expiresAt` берутся из сохранённой policy; для v1 целевой останов — 10 заданий примерно за 15 минут, жёсткие пределы — 12 заданий и 20 минут. Deadline одинаков для `in_progress` и `ready`, поздние answer/complete не создают evidence. Сохраняются только ограниченные ID, выбранный вариант, server-validated correct flag, явный `evidence_quality`, длительность и timestamps; raw audio, transcript и свободный текст отсутствуют. Replayable local-TTS browser speech у listening items считается `assisted` и получает explanation code `assisted_local_tts_diagnostic`: оно не создаёт independent mastery, не снижает uncertainty и публично помечается как ориентировочная проверка. Любые deep listening choices без реального audio и все Writing/Speaking multiple-choice probes тоже всегда `assisted`: распознавание стратегии не доказывает аудирование, самостоятельное письмо или речь; подтверждение даёт только фактически предъявленная listening-задача или реальная проверенная productive task. Повтор одного server-owned `skill_id:item_id`, в том числе тот же вопрос в short и deep catalog, сохраняется для последующей пользы, но только первое независимое наблюдение этой семьи остаётся strong evidence, а следующие получают `repeated_diagnostic_item`. Только ответы завершённой поддерживаемой версии становятся evidence-наблюдениями; брошенные/истёкшие и неизвестные версии не влияют на профиль. Marker поддерживаемого завершения входит в watermark, поэтому предварительный профиль не требует повторной диагностики. `needsDiagnostic` означает только первоначальную недостаточность evidence. Preview/create (включая replay) закрываются `ADAPTIVE_INITIAL_DIAGNOSTIC_REQUIRED`, пока у нового ученика нет завершённого short marker или достаточного genuine production evidence; плановая повторная диагностика через 4–6 недель показывается отдельно через `retention.rediagnostic.due` и не блокирует занятия. Сессии и ответы входят в экспорт владельца без idempotency fingerprints и внутренних replay snapshots и каскадно удаляются вместе с `users`.

Совместимость с сохранёнными результатами Voice Tutor также версионирована как `voice-tutor-skill-compat-v2`. Явная exact/prefix-карта переводит production-семейства `ege.grammar.topic_*|generated_*`, `ege.word_formation.*`, `ege.collocation.*`, `ege.vocabulary.lexeme_*|generated_*`, `ege.reading.evidence`, `ege.listening.evidence`, writing `writing_37|writing_38|email|essay.criterion.*` и поддерживаемые speaking criteria в навыки `ege-en-v2`. Для Speaking критерий 1 задания 4 относится к содержанию, критерий 2 — к организации, а объединённый языковой критерий 3 намеренно не засчитывается ни грамматике, ни лексике без отдельной validated-классификации. Отдельно учитываются чтение вслух, прямые вопросы, полнота интервью, содержание и организация монолога, грамматика/лексика устной речи, беглость, произношение слов/фонем и качество сигнала. Несколько наблюдений одной официальной попытки имеют общий `source_attempt_id`, поэтому раскрывают разные навыки, но считаются одним независимым источником. Для известных семейств проверяется допустимый исходный модуль: несовпадение не проваливается в посторонний fallback. Неизвестные recovery/repeat ID также не получают конкретный микроскилл и не могут стать независимым подтверждением; консервативный module fallback разрешён только для обычных module attempts. Внутренний DTO `save/getAdaptiveLearningProfile` одинаков для file/PostgreSQL: содержит только allowlisted профиль с вложенными `estimates`, сортирует их по `skill_id`, нормализует timestamps в ISO и не возвращает owner/backend-only поля. Экспорт использует тот же mapper и разделяет нормализованные profile/estimates без изменения их полей. Цели также проходят через один allowlisted mapper в save/get/API/export обоих backend: внутренние owner/idempotency-поля исключены, а `created_at`/`updated_at` имеют одинаковый ISO/null JSON-вид.

`profile_calculation_revision` отделяет версию алгоритма расчёта от схемы evidence watermark и имеет первый приоритет: новая ревизия может намеренно отфильтровать ранее учитывавшиеся источники, а старая не перезапишет новую даже с большим или более поздним набором. Внутри одной calculation revision append-only `source_count` имеет приоритет над временем: больший backfill принимается даже с прежним/более старым latest timestamp, меньший набор отвергается, а время и затем версия watermark служат детерминированными tie-breaker при равном счётчике. File repository выполняет сравнение внутри своей сериализованной мутации. PostgreSQL держит owner-lock, сравнивает и пишет profile/estimates в одной транзакции, читает готовый allowlisted снимок тем же transaction client до `COMMIT`, затем возвращает уже захваченный DTO. Overview строится только из этого авторитетного результата save, поэтому rejected stale-кандидат не попадает в HTTP-ответ.

PostgreSQL читает attempts/recoveries/repeat attempts одним aggregate SQL statement и тем самым не создаёт orphan repeat между разными `READ COMMITTED` снимками. Profile вместе с 21 estimates также читается одним statement в get, save-before-COMMIT и export, поэтому публичный DTO никогда не смешивает две ревизии.

Миграция `033_adaptive_learning_plan.sql` хранит версионированные owner-bound планы `adaptive-plan-v1`, включая nullable `base_plan_revision` для compare-and-set. План строится прозрачной rule-based формулой из текущей цели и авторитетного profile snapshot: активный диапазон баллов не является гарантией и содержит confidence, assumptions, требуемые минуты и конкретные варианты действий. `requiredWeeklyMinutes` инвертирует ту же capacity-формулу, что и диапазон, включая uncertainty и коэффициент эффективности `0.75`, после чего округляется вверх до пяти минут. `increase_weekly_time` всегда строго больше текущего времени, не превышает 2520 и правдиво сообщает sufficiency/constraint; при уже выбранных 2520 равное «увеличение» не создаётся. Последние дни используют реальную положительную дробь недели. С наступлением/истечением UTC-даты экзамена forecast становится `exam_date_expired`/`action_required`: score range, confidence и requirement равны `null`, weeks — `0`, а единственное действие требует обновить дату. Приоритет микроскилла сочетает разрыв до цели, вес ЕГЭ, due/overdue pressure, относительное усиление high-impact/large-gap навыков при приближении экзамена и uncertainty; высокая uncertainty создаёт `diagnostic_probe`, а не фиктивное mastery. Целочисленные allocations содержат точный канонический набор из 21 навыка и шести модулей, отдельно дают ровно 100%, а module share совпадает с суммой его skills уже на первой ревизии. Обычная следующая ревизия ограничена 10 percentage points на каждый видимый навык и модуль. `overdue` и `critical_due` лимит не снимают; до Ticket 06 единственный разрешённый reset — новая ревизия цели. `critical_retention_expiry` остаётся reason code приоритета, но bypass включится только после появления persisted owner/profile-bound expiry и его repository-side derivation.

Input fingerprint связывает revision цели, полный profile evidence-вектор, точную `base_plan_revision` и UTC-день пересчёта; он нужен только для идемпотентности и не входит в export/API. File repository сериализует mutation, а PostgreSQL берёт общий owner row lock. В обоих backend полный structural validator и пересчёт fingerprint из supplied outer metadata выполняются до duplicate lookup. Затем, всё ещё внутри той же owner mutation/transaction, repository заново читает авторитетные evidence sources и сверяет с ними как persisted profile, так и plan candidate по единому вектору `calculation revision + watermark version + source count + observedAt + content fingerprint`. Проверка выполняется до replay: даже полный исторический кандидат не может вернуть план, если его evidence уже устарело, и закрывается `ADAPTIVE_PLAN_EVIDENCE_STALE`. Route ограниченно повторяет весь overview-цикл — новое чтение evidence, сохранение профиля, построение и сохранение плана — поэтому изменение данных между profile save и plan save не оставляет устаревший current plan. Для допустимого кандидата repository заново строит deterministic plan из полной persisted current goal (`target_score`, `exam_date`, `weekly_minutes`), полного profile со всеми 21 skill estimates и current plan. Candidate envelope, forecast, allocation и stability должны точно совпасть с rebuild; synthetic mastery/uncertainty/due-state, goal или shape-valid JSON не сохраняются. CAS принимает запись только с фактической текущей базой, а route также ограниченно пересчитывает base/goal conflict уже от победившей ревизии. Перед записью repository независимо проверяет лимит ±10 для каждого видимого элемента, разрешая reset только для новой ревизии цели. Порядок plan input сначала сравнивает goal revision, затем общий calculation-first evidence watermark и только затем daily bucket. `PUT /goal` возвращает один согласованный current goal/profile/plan snapshot: `created` относится только к остающейся current ревизии, а `replayed`/`superseded` объясняют старый claim или конкурентную смену. API всегда возвращает авторитетную сохранённую current revision. История планов входит в owner export через общий allowlisted DTO и каскадно удаляется с `users`; свободный текст, raw audio, transcript, эссе и ответы в неё не копируются.

Ticket 09 добавляет второй явный stability reset: `taxonomy_changed`. При смене канонической taxonomy version старое allocation сначала отделяется от новой shape и не попадает в stability map. Поэтому persisted `ege-en-v1` безопасно становится `ege-en-v2`, сохраняя CAS-связь с `base_plan_revision`; обычные ревизии по-прежнему ограничены ±10.

Rollout закрыт по умолчанию: `ADAPTIVE_LEARNING_ENABLED=false` не регистрирует API и оставляет UI-entry скрытым. Сервер проецирует тот же флаг как `/api/v1/me.features.adaptive_learning`; браузер не может включить API локальным изменением разметки.

`writing_attempts` и `speaking_attempts` — пользовательские данные, а не эталонная выборка:
запись в этих таблицах не даёт ответу экспертной оценки и не создаёт пути автоматического импорта
в `quality/`. Они включаются в экспорт аккаунта и удаляются каскадно вместе с пользователем.
Миграция `019_attempt_models.sql` добавляет nullable-поле `model`, поэтому прежние строки остаются
валидными с неизвестной моделью (`NULL`), а новые завершённые прогоны сохраняют полную тройку
`provider`, `model`, `prompt_version`.

Voice Tutor обращается к этим журналам только через owner-bound lookup по `(username, id)`. Для
`writing` допускается лишь `status=completed`, валидные assignment/review и ровно сохранённый
`evaluated_answer`; для `speaking` — лишь attempt с `review.status=scored`, сохранённые
assignment/transcript и повторно провалидированный review с числовыми `got/max`. Эти данные
передаются только в transient provider capsule и не
копируются в `voice_tutor_sessions`, её публичный ответ или раздел этой таблицы в account export.
Сервер выдаёт bounded-названия и индексы критериев с потерями, а при создании отдельной сессии
повторно проверяет выбранный индекс по сохранённому review. Tutor session не обновляет review/score и не
запускает evaluation operation повторно.

Миграция `020_writing_evaluated_answer.sql` добавляет обязательный `evaluated_answer`. Для прежних
строк он заполняется полным `answer`; в новых попытках `answer` хранит весь очищенный ответ, а
`evaluated_answer` — ровно тот фрагмент, который получил провайдер. Оба поля входят в экспорт и
удаляются каскадно вместе с аккаунтом.

Миграция `021_voice_tutor_entitlements_and_quotas.sql` не повышает существующие подписки до
Premium: без отдельной строки `voice_tutor` пользователь остаётся на базовом тарифе. Резерв квоты
и единственная активная сессия защищены транзакционной блокировкой пользователя и уникальным
частичным индексом. Записи входят в экспорт и удаляются каскадно вместе с аккаунтом; аудио и
свободный transcript в таблице отсутствуют.

Миграция `022_voice_tutor_tracer.sql` добавляет bounded server-owned capsule, hash одноразового
nonce, способ доставки и конечное педагогическое состояние. Исходный ответ проверяется сервером до
создания capsule и в нормализованном bounded-виде остаётся только в metadata исходной
`module_attempt`: так каждый следующий AI-text turn может заново собрать точный контекст по
server-owned attempt id. В `voice_tutor_sessions`, её capsule и экспорт этой таблицы ответ не
копируется. В записи сессии остаются только результаты micro-check/transfer и технический outcome;
аудио и временные субтитры не записываются.

Миграция `023_trusted_rule_cards.sql` вводит переходы `pending_review → approved|rejected`.
Решение рецензента идемпотентно и записывается в bounded `review_audit`; сменить уже принятое
решение через API нельзя. Canonical lookup фильтрует `status = 'approved'`. Карточка, созданная для
текущего разбора, входит в экспорт ученика; pending/rejected report удаляется вместе с аккаунтом,
а approved canonical сохраняется без creator identity. Совпавший reviewer обезличивается только в
оставшихся карточках. Source records содержат только URL,
retrieval time и SHA-256 страницы, но не HTML/текст страницы.

Миграция `024_voice_tutor_recovery_map.sql` добавляет в Voice Tutor session bounded-счётчики
`micro_check_attempts`/`micro_check_passes` (без ответов ученика) и создаёт карту только из проверенного события
`transfer_answer` существующего Voice Tutor FSM. Клиент не может записать outcome, skill, rule или
потенциальные баллы. Повторы получают новый server-owned `task_id` и отдельный UUID попытки, поэтому
исходное задание и transfer-пример сессии не засчитываются повторно. `day_1` открывается через 24 часа,
`day_7` — не раньше семи суток от outcome и не раньше шести суток после позднего day-1 pass. Окно
24 часа используется как UX-метка: overdue остаётся доступным. Непроверенная просрочка остаётся
`open`, а `relapsed` возникает только после неверного ответа на новый серверный аналог. Новая
сессия того же skill заменяет только старые непредъявленные повторы; завершённая история сохраняется.
Server-owned mapping ограничивает потенциал одного episode: grammar/vocabulary/reading/listening —
до 1 учебного балла, writing/speaking — до 2 и не выше сохранённой потери критерия. Сумма в UI —
приоритет обучения Easy Boost, а не прогноз или официальный пересчёт первичных/тестовых баллов ЕГЭ.

Миграция `025_voice_tutor_hardening.sql` добавляет bounded `provider`, `model` и
`prompt_version` к `voice_tutor_sessions`. Они входят в account export как техническое
происхождение структурированного результата, но provider credential и nonce hash не входят.
Та же миграция страхует связь rule card creator через `ON DELETE SET NULL`; repository до удаления
аккаунта удаляет pending/rejected reports и отсоединяет approved canonical. Reviewer audit в
оставшихся карточках становится обезличенным фактом решения.

Миграция `029_voice_tutor_realtime_proxy.sql` добавляет SHA-256 one-use app ticket, время его
выдачи/истечения/consume, bounded reissue counter, input/output PCM bytes, usage confirmation,
finalization reason и time. Raw ticket, API key, audio и transcript в БД не записываются. Ticket
hash и reissue counter исключены из account export; bounded byte/finalization evidence входит.
Первая потерянная выдача может быть атомарно заменена один раз, consume допускает ровно одного
победителя. Clean confirmed usage считает секунды по 48 000 PCM16 bytes/s; любой abnormal или
неподтверждённый исход сохраняет полную reservation. File и PostgreSQL mutations сериализуют
finish/delete/review/proxy races; partial unique index разрешает не более одной approved canonical
карточки для пары `(skill_id, exam_year)`. Перед созданием индекса миграция детерминированно
сохраняет прежний canonical с самым поздним `reviewed_at/created_at/id`, а legacy-дубликаты переводит
в `rejected` с системной audit-причиной; file repository выполняет ту же reconciliation при load.

Миграция `030_voice_tutor_fallback_and_recovery_tasks.sql` разрешает нулевой резерв только для
контекстного text/local-разбора после исчерпания голосовой квоты: такая сессия не может списать
голосовые секунды. Она также добавляет `repeat_tasks` к recovery-событию. Новые day-1/day-7
повторы берутся из двух отдельных server-owned аналогов того же skill, связанных с исходной capsule.
Они не совпадают с исходным заданием, сессионными micro-check/transfer или друг с другом;
module-wide задания для другого навыка больше не используются.

Миграция `026_premium_voice_commerce.sql` добавляет обязательный `product` (`base` или
`premium_voice`) к заявке и не меняет смысл прежних строк: они получают `base`. Для одного
пользователя допускается не более одной открытой заявки на каждый продукт. Решение Premium-заявки
в одной repository-транзакции переводит её в terminal status, продлевает `subscriptions` и
создаёт/продлевает `voice_tutor` до той же даты; повтор того же решения ничего не начисляет.
Отклонение не выдаёт доступ. Actor с тем же Telegram ID, что и владелец заявки, не может одобрить
её даже через repository API. Отзыв закрывает только уже начавшийся активный entitlement и
идемпотентен; на точной границе `starts_at` он безопасно возвращает `false`, не создавая нулевой
период, запрещённый SQL CHECK. Все
решения и отзывы получают `subscription_events` и `audit_log`; ученический API умеет только
создать заявку и прочитать её статус, поэтому self-grant отсутствует и в file, и в PostgreSQL
реализации.

Server-owned каталог grammar/word-formation/collocation/vocabulary генерируется из текущих
встроенных UI-банков командой `node scripts/build-core-voice-catalog.js`. Команда с `--check`
падает при рассинхронизации. Для сгенерированного ИИ-контента сервер связывает opaque item id с
owner-bound `generated_tasks`, заново валидирует typed result и его digest при записи ошибки и при
сборке capsule; reference/правило из запроса браузера не принимаются.

Для reading/listening capsule сохраняет только server-owned фрагмент текущего пункта до 600
символов (`source_excerpt` или `transcript_segment`), но не полный текст/транскрипт и не ответы
соседних пунктов попытки. Такие ошибки нельзя создать по одному присланному варианту: endpoint
`/api/v1/voice-tutor/context-attempts` сначала сверяет весь завершённый набор и все ответы с
канонической ревизией. Он сохраняет родительскую `voice_tutor_context_result` и детерминированные
дочерние `voice_tutor_error`; только дочерняя запись с marker родительской проверки допускается к
созданию reading/listening capsule. Для ИИ-наборов server-issued идентификатор связывает request
hash и digest точного typed result из пользовательской строки `generated_tasks`; перед созданием
результата и при каждом fallback сервер заново загружает эту owner-bound запись, проверяет digest и
валидирует typed result, а не доверяет присланному клиентом тексту. Повтор result UUID допустим
только с тем же hash нормализованных ответов и возвращает те же детерминированные child IDs.

## Проверка миграций и repository

```bash
npm run test:postgres
```

Команда создаёт уникальный Compose project из `compose.test.yml` с базой
`easyboost_repository_test`, применяет каждый файл из `migrations/` через `scripts/migrate.js` и
проверяет публичный `createPostgresRepository` на реальной PostgreSQL 17. Порт публикуется только на
loopback и выбирается автоматически. Переданный извне `DATABASE_URL` не используется: runner задаёт
test-only URL сам. В блоке `finally` выполняется `docker compose down --volumes --remove-orphans`,
поэтому повторный прогон начинает с пустого volume и не зависит от прежних данных.

Обычный `npm test` сохраняет защитный skip этого integration-теста, если `TEST_DATABASE_URL` не
задан: он остаётся доступен в окружениях без Docker. Обязательный PostgreSQL gate локально и в CI —
именно `npm run test:postgres`: Docker использует локальный `postgres:17-alpine` или автоматически
загружает его на чистой машине.

Миграция `027_voice_tutor_pedagogical_loop.sql` заменяет прежний полный session capsule на
`voice-tutor-reference-*` (IDs/version/source/skill/hash), добавляет bounded
`clarification_turns` и `voice_tutor_reports`. Report содержит только owner/session/rule UUID,
enum reason/status, timestamps и review audit. PostgreSQL create+bind provisional rule выполняет
`SELECT ... FOR UPDATE`, insert card и update capsule/FSM в одной транзакции; file repository
сериализует тот же участок двумя mutation queues. Source attempts остаются единственным местом
учебного ответа, а canonical catalog/review заново строят transient capsule на каждом event.

Миграция `028_voice_tutor_discovery_claims.sql` удаляет из всех прежних session capsules
`content_hash`: persisted reference больше не содержит fingerprint, производный от ответа ученика.
Она также добавляет owner-bound discovery claim/status и durable `ai_requests.claim_key`. Внешний
поиск или extraction начинается только после атомарного `in_progress` slot; terminal
`completed|failed` settlement идемпотентен, а неуспешный вызов остаётся наблюдаемым и консервативно
учитывается в лимите. PostgreSQL mutations берут блокировки в порядке user → voice session/card,
совпадающем с удалением аккаунта; file repository сериализует тот же контракт.

## Адаптивные учебные сессии (миграция 034)

Миграция `034_adaptive_learning_sessions.sql` добавляет owner-bound таблицу
`adaptive_learning_sessions`. Каждая строка связывается с неизменяемой ревизией
`adaptive_learning_plan_revisions`, хранит версии composer/content/taxonomy, начало UTC-недели,
точную длительность, структурированный снимок недельного бюджета и только opaque server-owned
activity/content references с проверенным `adaptive-launch-v1` descriptor. Descriptor — строгий union
`vocabulary_practice|grammar_practice|exam_workflow|reading_mode|listening_mode|writing_task|speaking_task|voice_tutor_recovery`: он содержит
только allowlisted screen/mode/topic/task identity и вызывается соответствующим экраном задания.
`vocabulary_practice` открывает реальную очередь `scr2` из `EGE_WORDS`/SRS в режиме lexical choice;
word formation не выдаётся за готовый consumer и остаётся явным `coverageGaps`. Его доля получает
`content_coverage_fallback` и в первую очередь направляется в исполнимую лексическую практику того же
модуля. Общий маршрут без точного activity consumer не сохраняется. Исходные ответы, эссе, transcript
и audio в сессию не копируются.

SQL CHECK фиксирует диапазон 15–120 минут с шагом 5, ровно один 10-минутный перерыв для сессии
дольше 60 минут, равенство общей/учебной/перерывной длительности, допустимые статусы и единственную
ревизию замены. Partial unique index разрешает только одну текущую `created|in_progress` сессию на
владельца. Недельный snapshot хранит rolling priority: target, фактические planned/selected minutes
(включая неизбежный overshoot малого target полноценным блоком), компенсирующий deficit и
версионированное prerequisite evidence:
только fingerprint полного структурированного профиля и список доказанно слабых prerequisite skills,
без исходного evidence. Создание и единственная замена хранят owner-global request key/hash и точный
allowlisted response snapshot для lost-response/concurrent replay; эти внутренние поля не входят в
экспорт. Оба backend используют общий exact create validator и общий immutable transition validator.
PostgreSQL вызывает их под owner lock и CAS по revision, а file repository — внутри сериализованной
mutation queue. Повтор key для другой сессии владельца является конфликтом. `ON DELETE CASCADE`
удаляет сессии вместе с аккаунтом.

## Исполнение адаптивных сессий (миграция 035)

Миграция `035_adaptive_session_execution.sql` добавляет к `adaptive_learning_sessions`
независимую `execution_revision`, server timestamps старта/завершения и минимизированный итог.
`current_block_id` становится nullable только тогда, когда все block-completion events уже записаны
и сессия готова к явному `finish`.

`adaptive_learning_execution_claims` хранит только SHA-256 от короткоживущего opaque token,
owner/session/block/revision, fingerprint точного launch descriptor, срок действия и одно связанное
attempt reference. Сам token не хранится ни в claim row, ни во внутреннем mutation response snapshot:
snapshot содержит только UUID claim, а exact start replay реконструирует тот же bearer через
domain-separated HMAC серверного секрета. Bearer не попадает в журнал, экспорт или release evidence. Claim нельзя
перенести между владельцами, блоками, активностями или ревизиями; истёкший/отозванный claim не создаёт
доказательство. Если claim уже связан с точной попыткой, но ответ `advance` потерян, повторный `start`
возвращает эту же attempt reference без нового claim; browser сохраняет durable recovery-control до вызова `advance`.
Для server-owned writing repository дополнительно проверяются completed status, task identity и
создание попытки после выдачи claim; speaking допускается только с `review.status=scored` и
числовыми `got/max`, поэтому `needs_retry` не может завершить адаптивный блок.

`adaptive_learning_session_events` — append-only allowlisted журнал `block_completed|session_finished`:
идентификаторы блока/skill/activity/source, класс происхождения evidence, плановые и доступные
фактические минуты и timestamp. Там нет score, learner answer, essay, transcript, audio, prompt или
model response. Уникальности `(session_id, sequence)` и `(session_id, block_id)` запрещают двойное
завершение. `adaptive_learning_session_mutations` хранит owner-global key/hash и точный response
snapshot для `start|advance|finish`; они внутренние и не экспортируются. PostgreSQL owner lock и
file mutation queue обеспечивают одинаковый CAS/replay contract. Все три таблицы удаляются каскадно
вместе с владельцем; экспорт включает только session events.

Миграция `036_adaptive_execution_hardening.sql` добавляет фактический педагогический контекст
`exam_practice|planned_practice|scheduled_review|ai_assisted_review` в claim и событие. Контекст не
утверждает, что работа была новой, на время или без подсказок, и не повышает качество клиентской
самопроверки. Миграция отвязывает attempt reference и отзывает все legacy bearer claims, включая consumed,
затем удаляет только legacy start snapshots с открытм bearer. Так старая Writing/Speaking-привязка без exact-task полей не блокирует
сессию: блок можно безопасно запустить заново. Повторный запуск миграции сохраняет новые HMAC claims по claim-id-only snapshot.
Она также фиксирует точную server-owned привязку: writing
attempt хранит `source_task_ref`, speaking attempt — fingerprint канонического assignment. Поэтому
completed ответ того же типа, но к другой карточке, не может завершить блок. PostgreSQL читает
current/advance/finish контексты в `REPEATABLE READ`, а конкурирующие mutations придерживаются порядка
блокировок owner → session/claim, чтобы не смешивать ревизии и не создавать deadlock с удалением владельца.

Миграция `037_adaptive_retention_premium.sql` добавляет к skill estimate nullable
`critical_retention_expires_at` и разрешает существующему execution claim/event ссылаться на
`voice_tutor_repeat`. Значение expiry не принимается от клиента: overview строит его из owner-bound
day-1/day-7 recovery map, а repository разрешает одинаковому evidence watermark только монотонный
переход `not_due → due → critical_due` и точный неизменный critical expiry. Это даёт
`adaptive-plan-v1` узкую authority для stability bypass только expiring skill/module; repository
повторно строит кандидат из сохранённого профиля и отклоняет придуманный scope.

Retention-блок хранит только точные repeat/task/skill/module identifiers и UTC due/window, но не prompt или
ответ. Привязка попытки проверяет owner, session/block/claim, объявленные в launch repeat/task/window,
skill/module и время
создания после claim; событие получает `source_type=voice_tutor_repeat`,
`evidence_quality=server_verified_unassisted` и фактический `scheduled_review`. Сам ответ по-прежнему
проверяется транзитно существующим Voice Tutor repeat ledger и не попадает в adaptive storage.
Repeat attempt и consumption claim записываются в одной file mutation или PostgreSQL transaction;
ошибка exact binding не оставляет orphan attempt. Один shared validator используется при submit, bind
и advance в обоих backend.
Day-7 не попадает в executable retention projection, пока в той же recovery chain нет passed day-1 attempt;
если обе даты просрочены, session composer сначала выдаёт day-1 и не создаёт заведомо отклоняемый блок.
Deep Writing/Speaking остаются server-gated правом `voice_tutor`; day-1/day-7 обязательство,
созданное ранее, можно завершить после истечения Premium без нового AI/Voice вызова.

Для Premium-depth `start`, exact start/advance replay, `bind-attempt` и `advance` entitlement проверяется
после захвата file owner queue или PostgreSQL user `FOR UPDATE`; PostgreSQL использует
`clock_timestamp()`, поэтому устаревший request timestamp не может пережить уже завершённый отзыв.
Execution-claim authority follows the same boundary: start mints `issued_at` and the exact fixed two-hour
`expires_at` only after the owner queue/user lock, and the locked response snapshot uses those stored timestamps.
Exact start replay, module binding, server-owned Writing/Speaking binding, Voice Tutor repeat binding and advance
all compare expiry against a fresh post-lock authority time. A request captured just before expiry therefore cannot
create an attempt or event after expiry, and a delayed start cannot return a claim that was already expired when minted.
Старт сверяет revision/replacement и fingerprint точного launch со строкой под блокировкой до записи claim.
Замена fail-closed разрешена только при `status=created`, нулевой execution revision, отсутствии
`started_at`, claim и event; после начала исполнения новый запрос и exact replay получают
`409 ADAPTIVE_SESSION_REPLACEMENT_LOCKED`.

## Коммерческий scope и отчёты (миграция 038)

Миграция `038_adaptive_commercial_scope.sql` добавляет обязательный `commercial_scope` к
`adaptive_learning_sessions`. Новая Free-сессия получает `free_demo`, Base — `base`, Premium —
`premium`; прежние строки безопасно считаются `base`, поэтому истёкшую платную сессию нельзя принять
за одноразовое Free-демо. Репозитории атомарно запрещают вторую Free-сессию и повторную завершённую
Free short-диагностику, а маршруты повторно проверяют текущий тариф на preview/create/current/replace/
start/bind/advance/finish и на каждом шаге deep-диагностики. Уже выданный точный Voice Tutor repeat
остаётся завершаемым после истечения Premium только в ранее определённом узком recovery-сценарии.

Подробный Premium-отчёт не создаёт новую таблицу и не копирует учебный контент: он строится на чтении
не более 12 последних `completed` session rows и их bounded `completion_summary`. Экспорт содержит
отдельную производную `adaptive_learning_reports` с `session_id`, `completed_at` и тем же allowlisted
summary; ответы, эссе, transcript, audio, prompt и model output туда не попадают. Удаление владельца
каскадно удаляет исходные сессии, поэтому производный отчёт также исчезает в file и PostgreSQL.

## Операционные агрегаты Ticket 08

`adaptiveLearning` не добавляет таблиц и не является новым retention-классом. File backend строит
`adaptive-metrics-v1` из одного сериализованного repository snapshot; PostgreSQL — из одной
`REPEATABLE READ` read-only транзакции. Оба backend применяют одно скользящее 90-дневное окно и
возвращают только
фиксированные duration/commercial/reason/evidence buckets, счётчики и rates. Идентификаторы
владельцев, сессий, попыток и навыков в результат не проецируются.

## Reading 2.0 report

`reading-report-v1` также не добавляет таблиц и не хранит отдельный snapshot. File и PostgreSQL
repository одинаково возвращают не более 120 последних `module_attempts` только текущего owner с
`module=reading`. Доменный агрегатор принимает лишь точные ID и revision замороженного каталога,
expected activity/content reference/provenance, корректные баллы и duration. Полный раздел считается
завершённой попыткой только при наличии связанной пары gist + detail; дубли, неполные, технические,
сгенерированные и legacy строки исключаются. Base и expanded строятся детерминированно из одного
набора строк; expanded дополнительно требует свежий server-side `voice_tutor` entitlement. Исходные
ответы, тексты, evidence-цитаты, Voice payload и entitlement от клиента endpoint не принимает.

Миграция `039_adaptive_metrics_window_indexes.sql` добавляет индексы timestamp для sessions,
learning events, completed diagnostics и обновлённых skill estimates. PostgreSQL получает четыре
fixed-shape aggregate rows с time predicates; raw lifetime sessions, JSON blocks и event rows в
процесс мониторинга не загружаются.

Локальный migration proof Ticket 08 применяет полный набор `031`–`039` к чистой PostgreSQL и затем
запускает repository contracts. Наличие схемы не включает функцию: API и UI дополнительно закрыты
`ADAPTIVE_LEARNING_ENABLED=false` по умолчанию.

## Speaking accent profile and calibration (migration 049)

`049_speaking_accent_calibration.sql` adds nullable bounded `audio_hash` evidence to
`speaking_pronunciation_assessments`, `speaking_accent_profiles` plus append-only
`speaking_accent_profile_history`, and a unique owner row in `speaking_accent_calibrations` for the
one-time unknown-accent setup. Its lifecycle is `pending`, `completed` or `cancelled`; choosing a manual
profile cancels a pending setup atomically and a cancelled setup cannot later overwrite that choice.
Every task 1–4 and full-section session now has the all-or-none snapshot
`accent_locale`, `accent_profile_revision`, `accent_effective_at`, so a profile mutation can only affect
future assignments. The only nullable-accent exception is a new task 1 row with
`calibration_setup_id` bound to the learner's exact pending setup; the check constraint forbids combining
that ID with an accent snapshot. Legacy nullable task 1 rows and every nullable task 2–4/full row fail
closed at assessment time instead of borrowing any current setup.

`speaking_calibration_consents` stores the separate versioned consent, age group, guardian confirmation
and grant/revoke timestamps. `speaking_calibration_samples` stores a bounded PCM WAV as `BYTEA`, a
pseudorandom ID, owner-bound finalized assessment reference whose audio digest must match, task/locale/max-score facts, JSONB reviews
and access audit, bounded immutable `task_snapshot` and `rubric_snapshot` JSONB objects, lifecycle timestamps
and an exact 180-day expiry constraint. The snapshots are copied only from the validated server catalog at
enrollment, contain no learner answer or identifier and keep an old sample reviewable after catalog rollout.
The state check requires
raw audio to be present only while awaiting two independent sufficient ratings or third-party adjudication, and
requires `raw_deleted_at` after completion, revoke or expiry.

The owner foreign key uses `ON DELETE SET NULL` only for completed anonymous labels. Repository deletion
first removes unfinished samples and clears the completed row's assessment key and reviewer identities;
deleting an expert separately pseudonymizes the username in every review and access-audit entry;
all profile, history, setup and consent rows cascade. File storage implements the same projection and
delete contract with base64 only as its serialized representation of the same binary bytes.
PostgreSQL calibration setup/completion, contribution upload, consent mutation, assignment and account deletion
all acquire the owner row before setup/consent/sample rows. This owner → child order prevents privacy
revoke/delete from deadlocking a concurrent upload or calibration completion. Ordinary and full-section
assignment re-read the canonical profile under the owner lock immediately before creating a new session;
a stale route snapshot cannot override the stored revision. Queue claim applies review-count and active-lease
eligibility in SQL before `LIMIT 1`; audio read and submission enforce `expires_at` even when a claim lease
is otherwise still active.

## Speaking learning evidence and adaptive transfer (migration 050)

`050_speaking_learning_loop.sql` binds every new official speaking evaluation to the exact owner session,
task/catalog IDs and revisions, and snapshots the irreversible `assistance_used` flag. The source columns are
all-or-none and indexed by owner/session. Legacy attempts remain unbound and assisted by default, so they can
be displayed but cannot be promoted into mastery evidence.

The same migration adds nullable `accent_locale` to `speaking_attempts`, backfills it from the four canonical
session tables and constrains new values to `en-GB` or `en-US`. Claim and finish paths validate the session,
assessment and review locale before storing the attempt. Consequently pronunciation targets, outcomes and
dynamics are segmented by locale: evidence recorded for one accent can never retire a target for the other.

Task 1–4 sessions carry `assistance_used` and a nullable bounded `targeted_practice` JSON object; evaluated
`speaking_attempts` carry the same immutable target snapshot plus nullable `assistance_updated_at`. Database
checks reject non-object target JSON. Existing session rows are conservatively backfilled to true; newly assigned sessions
default to false and become true before any cheat sheet is shown. The attempt timestamp makes that change part of the adaptive evidence watermark: a later help request
invalidates an already persisted independent snapshot instead of leaving stale mastery behind. The marker is
monotonic and cannot be reset through the repository contract. The canonical
`speaking-learning-evidence-v1` projection is computed from the stored, revalidated review and bounded acoustic
facts rather than copied to another table. Only official, unassisted, high-confidence scored attempts publish
criterion observations into the adaptive profile. Premium targeted practice uses a fresh server-issued pointer,
excludes its source assignment and selects a different suitable server-owned task. If the catalog has no task
containing the bounded word/phoneme anchor, the target remains explicitly unavailable rather than disappearing.
The exact persisted target lets the next eligible evaluation publish `resolved`, `still_needs_work` or
`inconclusive`; retirement uses the stable normalized skill/kind/value/anchor identity, not an attempt-specific
provider event reference. Pronunciation events are applied chronologically: a score at or above 80 retires the
current target, while a later sub-80 regression reactivates it. Assisted, technical and low-confidence attempts
still publish an explicit inconclusive target outcome, but only reliable evidence changes mastery or trends.
Target identity includes `accent_locale`, so an accent change cannot cross-resolve it. Adaptive
Speaking launch uses a server-owned task descriptor and verifies that the exact session was assigned after the
execution claim.
PostgreSQL binds the launch in one transaction by locking the adaptive session before the Speaking attempt and
revalidating both immediately before consuming the execution claim. The Base/Premium learning report is likewise
a request-time projection; it adds no retention class.
Targeted assignment validates the client pointer and inserts its newly selected session inside the same owner-scoped
file mutation or PostgreSQL transaction. A concurrent assistance marker or newer evaluation that wins the owner lock
makes the old pointer return `SPEAKING_TARGETED_PRACTICE_STALE` instead of assigning from a stale report snapshot.
Both the report snapshot and a targeted assignment sample their effective authorization time only after acquiring
the file owner queue or PostgreSQL user `FOR UPDATE` lock. They first require
`subscription_until > effective_time`; an expiry committed after the route precheck therefore returns
`403 SUBSCRIPTION_REQUIRED`, exposes no report data and creates no targeted session. Only an active Base
subscription proceeds to the fresh `voice_tutor` entitlement check: losing Premium while Base remains active keeps
the Base report available and makes a Premium targeted pointer stale with 409, while active Premium retains the
targeted path.
The pointer includes the latest `reportRevision` and `accentLocale`; every newer evaluated attempt, including an
assisted, technical or different-skill attempt, invalidates it atomically. All 11 registered Speaking
micro-activities bind through the validated `speaking_<task-number>` activity family while retaining the exact
owner/session/task/catalog provenance. Adaptive profile compare-and-save runs under the same owner queue/transaction
and uses a deterministic evidence fingerprint in addition to timestamp/count, so a post-snapshot assistance mutation
cannot persist stale independent mastery even when wall-clock timestamps collide.

Adaptive profile input independently bounds Speaking evidence to the newest 120 owner attempts with status
`completed|needs_retry`, ordered by `COALESCE(evaluated_at, created_at) DESC, id DESC`. PostgreSQL applies
`ORDER BY ... LIMIT 120` before `jsonb_agg`; file storage slices before review revalidation/hydration. The compact
repository projection omits transcript, assignment and provider fields, while retaining the deterministic review and
the exact provenance fields required to revalidate evidence. `speakingAdaptiveEvidenceAttempts` repeats the same
newest-120 bound defensively before expanding one attempt into skill observations. Existing attempt rows remain
stored and owner-exportable: this is a derived-read bound, requires no migration and leaves owners with 120 or fewer
eligible attempts unchanged; a later overview simply recalculates the normal evidence fingerprint from the bounded set.

## Adaptive evidence content watermark (migration 051)

`051_adaptive_profile_evidence_fingerprint.sql` adds a nullable, lowercase SHA-256 content fingerprint to
`adaptive_learning_profiles`. Null remains readable for profiles written before this migration. Every newly
calculated profile stores the canonical fingerprint through file and PostgreSQL DTOs, export and public projection.
When calculation revision, source count and latest timestamp are identical but fingerprints differ, save performs
an owner-serialized comparison against the current evidence before replacing the profile. This lets a post-hoc
assistance marker remove stale independent mastery without allowing an older snapshot to restore it. One canonical
eligible-source projection produces the fingerprint, source count and latest timestamp together: unsupported or
uncredited rows cannot advance only part of the watermark. Known evidence timestamps are normalized identically
from `Date`, ISO strings, epoch milliseconds and epoch seconds, so file and PostgreSQL hash the same logical event
to the same identity.

## Adaptive plan evidence content watermark (migration 052)

`052_adaptive_plan_evidence_fingerprint.sql` adds the same nullable, lowercase SHA-256 evidence fingerprint to
`adaptive_learning_plan_revisions`. Existing revisions remain readable with null, while every new revision binds
its input fingerprint, outer persistence vector and embedded plan semantics to the authoritative profile content.
Therefore a same-count, same-timestamp post-hoc assistance change is ordered as newer evidence and creates one
coherent plan revision instead of replaying a stale allocation. The field is included in owner export and removed
with the plan history on account deletion. Immediately before duplicate replay or insertion, both repositories
re-read current evidence under the owner serialization boundary and require the persisted profile and candidate
to match its complete canonical vector. A stale candidate returns `ADAPTIVE_PLAN_EVIDENCE_STALE`; the HTTP route
then retries the complete profile-and-plan overview a bounded number of times.

Profile persistence uses the same bounded whole-overview retry policy even when no goal exists or plan
calculation is disabled. After three stale evidence snapshots the HTTP boundary returns retryable
`409 ADAPTIVE_PROFILE_RETRY_REQUIRED` with `Retry-After: 1`; it never substitutes an older stored profile
or combines it with newer retention/access data. A transient first- or second-attempt conflict still returns
one coherent fresh snapshot.

The eligible-source projection is deliberately type-strict. Attempt `score` and `max_score` must be actual
finite JSON/JavaScript numbers and `max_score` must be positive; recovery and diagnostic result flags must be
actual booleans. Nulls, empty values, numeric-looking strings and boolean-looking strings are excluded from
mastery, source count, latest time and fingerprint. File storage keeps raw legacy values until projection
instead of coercing them. PostgreSQL applies the equivalent `jsonb_typeof(...)= 'number'` guard to Writing
review JSON before casting, so corrupt persisted JSON has identical fail-closed behavior in both repositories.

## Full EGE mock attempt lifecycle (`053`)

Migration `053_ege_mock_attempts.sql` adds two owner-bound tables shared by the file and PostgreSQL repository contracts:

- `ege_mock_attempts` pins `owner_generation`, the exact authored form id/revision/fingerprint, exam year, diagnostic/training mode, monotonic attempt number and the answer-free timing policy identity `ege-mock-attempt-policy-v1`. That public version fixes a 190-minute written window, a 30-day oral-start window and the separate 17-minute oral timer, and is returned with the released form before start. The row owns the written draft, state/revision, all three server-authoritative boundaries, bounded oral recording metadata, server receipts, assessment state/retry count and the eventual result. A partial unique index permits only one unfinished attempt for an exact owner/form revision. Database checks pin all timer intervals, and the `users` foreign key deletes every attempt on account deletion.
- `ege_mock_mutations` is the owner-global idempotency ledger. Its primary key is `(username, idempotency_key)` and every row binds one exact operation, attempt, request hash and original response snapshot. Reusing a UUID for another operation, attempt or payload fails closed. These internal keys, hashes and snapshots are never part of account export.

Every PostgreSQL mutation locks the owner row and takes `clock_timestamp()` inside the transaction before rechecking the subscription and lifecycle. Compare-and-swap draft revisions and owner-global idempotency therefore serialize across concurrent requests. Timer reconciliation is persisted even when the triggering late mutation is rejected. File storage implements the same public contract through one shared attempt-mutation helper and its owner mutation queue; the route passes a clock thunk, and file storage evaluates it only after entering that queue, so a request that waits across a timer or subscription boundary cannot use its earlier arrival time. Both adapters delegate start/current active-state selection, diagnostic-to-training mode/attempt-number decisions, draft, written submit, oral start/submit and assessment retry guards/transitions/response construction to the same pure `ege-mock/attempt.js` operations; adapters retain only queue/owner-lock authority, reconciliation, replay and persistence. That module exports only guarded lifecycle/apply operations, reconciliation, the start decision and safe public/export projections; raw transitions, payload digests, normalizers and duration constants remain private implementation details. The shared file/live-PostgreSQL contract races written and oral submission with distinct owner-global UUIDs at one revision, requires exactly one winner and verifies that export contains the winner's single receipt. Manual and automatic receipts contain a SHA-256 digest of the full server-frozen ordered part payload, including explicit `null` placeholders for every unanswered position; the client request hash is never substituted for that authority. Read projections contain learner drafts but never authored assessment keys; result access remains locked until both written and oral parts are complete. Account export first reconciles timers in the same file queue or PostgreSQL owner-locked transaction, then uses one allowlisted attempt mapper. Account deletion cascades attempts plus their mutation ledger in both backends.

## Provisional EGE writing assessment (`054`)

Current-attempt, named-attempt and result reads are side-effect free: they never claim a writing job, reserve an AI
usage row or call a provider. The owner-bound browser starts or recovers automatic assessment through the explicit
idempotent `POST .../assessment/run` mutation after submission and queued reload; retry and acknowledged ambiguous
replacement remain distinct POST mutations. Migration `054` extends the owner-global mutation operation check with
`assessment_run`: a pending snapshot remains resumable under the exact operation/attempt/payload-bound UUID. A
completed/retryable/ambiguous disposition replaces it with the immutable public response used by exact replay. If
the owner lock finds neither an active subscription nor already-frozen authorization, the same transaction stores
`writing_assessment.run_disposition = subscription_required` and an immutable applied response bound to that exact
UUID and attempt. Current/named attempt and safe result projections retain this terminal block without dispatching
work. A pre-block pending UUID and any new unmarked UUID terminalize with the same block after renewal and cannot
dispatch. Clearing requires both a new request-hash-bound UUID carrying `explicitRenewal:true` from the learner's
explicit action and a current active subscription inside the owner lock; replay of every rejected UUID remains
immutable.
The same repository owner lock that guards a claim rechecks current
subscription and version-bound consent immediately before any new provider authorization.

Migration `054_ege_mock_writing_assessment.sql` adds the bounded `writing_assessment` JSONB column to the owner-bound attempt row and nullable `ai_requests.context_fingerprint` with a lowercase SHA-256 check. Its database constraint pins the assessment version, a non-negative JavaScript-safe integer `assessment_revision` no greater than `9007199254740991`, the private internal `provisional` score kind, the finite job states (including explicit `ambiguous`) and a 300 KB ceiling sized for both API-bounded Unicode answer copies plus the immutable rubric metadata. `assessment_revision` is server-owned, separate from the draft/lifecycle row revision and incremented on every assessment, result or run-disposition mutation. The shared domain permits `9007199254740990 → 9007199254740991`; another mutation fails with bounded `ASSESSMENT_REVISION_EXHAUSTED` before changing the assessment or settling its mutation-ledger row. Current/named-attempt/result reads and frozen mutation snapshots project it as `writingAssessment.assessmentRevision`; an immutable old replay therefore remains exactly auditable without becoming current authority. Browser shared-storage merge compares this authority independently from the attempt draft revision: higher replaces the complete assessment projection atomically, lower is ignored, and equal requires exact recursive semantic equality. The snapshot contains the exact immutable form/criteria fingerprints, sanitized full and evaluated answers, deterministic FIPI word/cutoff scope, per-task work state, optional terminal assessment-run disposition, validated criterion review and bounded provider/model provenance. The shared normalizer treats slash forms and ordinal hyphen compounds such as `21st-century` as one word. Task 37 counts an artificial consecutive run of three or more identical words once and leaves repeated multiword phrases intact. Task 38 counts two or more adjacent copies of either one identical word or one identical multiword combination as a single occurrence. Exact copied assignment-question tokens, even without terminal punctuation, and structural task-38 headings are excluded. The exact whole-question/whole-sentence boundary fragment remains retained without treating decimals or common abbreviations as sentence ends and with Unicode-ellipsis support. The learner target remains 100–140/200–250, assessment-range state uses the official gradable shoulders 90–154/180–275, and an overlength scope records the formal cutoff as `evaluatedWords: 140|250` even when the retained atomic boundary fragment physically ends just before or after it. Task 37 excludes only an anchored leading From/To/Subject/date/numbered-postal-address block, including up to two structural city/country lines, until the greeting or first prose line; counting begins with the greeting and includes the signature, while an unnumbered first line ending in Street/Road/Square is ordinary prose. Task 38 builds one immutable published-source corpus from the pinned topic, row labels and percentages; exact contiguous matches of at least ten words covering strictly more than 30% of the assessable fragment deterministically force K1 and the complete score cascade to zero. It is never a second attempt or a source of official final authority.

File and PostgreSQL repositories expose the same small claim/renew/prepare-outcome/record-outcome/complete/fail interface. The first claim locks the owner and attempt, rechecks active subscription, reads current version-bound `text_processing` consent inside that owner mutation/transaction instead of trusting the caller boolean, revalidates the complete form/content/criteria snapshot, and then stores the exact authorization time, subscription expiry, consent decision and policy version with exactly two work items for positions 37 and 38. PostgreSQL and consent mutation use the same owner-first lock order, so a committed revocation that wins the lock wins provider authorization. A later owner/token-bound reclaim uses frozen valid authorization instead of pretending to start new work; therefore an already-authorized paid evaluation may recover and settle after entitlement expiry, while new provider work remains denied. Claiming grants one five-minute renewable lease. Renewal takes the same owner/attempt lock and exact claim token. The service renews before every item and physical primary/fallback/repair call and again around durable result recording, usage settlement and completion. Because an application provider call is bounded to at most 60 seconds, no paid call can outlive its renewed lease; every write remains fenced by the same durable claim token. Before provider work, the item stores an owner/attempt/item-bound UUID result token and the complete form, assignment/content and criteria reference/fingerprint/snapshot binding built and validated through one canonical seam. A canonical context SHA-256 is stored in the AI budget row before each physical call; claim replay with drift fails closed. Record, completion and replay revalidate those exact JSON values; comparison is insensitive only to object-key order so PostgreSQL JSONB canonicalization cannot change meaning, while any missing, extra or drifted value fails closed before a score is applied. After a valid response, the same token atomically records the validated review, bounded provenance and the settlement facts for every physical fallback or repair call. Settlement and completion replay from durable data and never evaluate a paid response again. A transport/timeout failure after reservation retains the item token as `prepared_unknown`. Automatic recovery of `prepared` or `prepared_unknown` only asks the adapter's durable idempotency lookup without a paid call. A recovered result is revalidated and recorded; unsupported/not-found lookup becomes explicit `ambiguous`, retains the reservation and is excluded from automatic retry. Only an explicit retry with `acknowledgePossibleProviderRepeat: true` may atomically append a bounded tombstone for the old reservation, clear it and issue a new UUID. Old in-progress or failed call rows continue to count toward budget. A concurrent claim cannot reserve work twice; an expired lease makes only unfinished items recoverable. Completion revalidates every score and criterion against the immutable snapshot, including the pinned first-criterion-zero implication for both tasks and the task-38 published-source cascade, is exact-replay safe, and publishes a total only after both items complete. Ordinary failures remain `retryable` with a null public score; ambiguous work carries the exact repeat-risk warning and also keeps a null score. The bounded retry transition preserves completed or durably recorded items. Validated public feedback contains no more than five evidence entries; their kind is exactly `err|warn`, title/note are non-empty bounded strings, and wrong/right text is bounded. Account export includes the owner-visible attempt snapshot and context-bound AI rows; account deletion removes both. Public attempt/result projections omit full/evaluated answers, prompts, claim tokens, result tokens and provider payloads and always carry the shared `mode: experimental`, `scoreKind: approximate` and exact canonical warning in editors and terminal states; these values explicitly deny final or expert authority. OpenAPI discriminates completed results from incomplete results and exact public assessment states: completed is terminal with `retryAllowed:false`, ambiguous requires the canonical repeat warning, and completed results have one exact task-37 plus one exact task-38 completed item. Generated standard `oneOf` contracts bind each position to its exact scope and filtered rubric: a zero communicative criterion permits only the all-zero vector; below 90/180 words permits only that vector; 90–154/180–275 binds `evaluatedWords` exactly to `fullWords`; above the shoulder binds the formal 140/250 cutoff. Each completed item also binds its criteria reference, pinned fingerprint and exact criterion name/maximum tuple; criterion points cannot exceed the pinned maximum and item/overall scores equal their criterion/item sums. Every incomplete shape has a null score and at least one unfinished item.
