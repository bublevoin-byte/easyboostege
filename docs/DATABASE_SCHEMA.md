# Схема базы данных

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
| `adaptive_learning_profiles` | версия и уверенность объяснимого профиля ученика | taxonomy/weighting/watermark versions, monotonic calculation revision, latest source timestamp/count, preliminary/status flags, confidence, independent/assisted/client-reported counts, established skill count and reason codes |
| `adaptive_learning_skill_estimates` | структурированные оценки микроскиллов без копий ответов | skill/module, mastery, uncertainty, raw/effective/independent counts, evidence quality, per-skill status, due state, server-derived critical retention expiry and explanation code |
| `adaptive_learning_plan_revisions` | owner-bound история объяснимых прогнозов и недельных распределений | exact base/goal/profile revisions, evidence watermark/count, UTC daily calculation bucket, bounded forecast/allocation/stability JSON, internal input fingerprint and current marker; deterministic `calculatedAt` is derived as bucket start while `created_at`/`updated_at` remain receipt timestamps; duplicate replay additionally requires an exact normalized outer-vector and plan-semantic match, ignoring only regenerated ID and receipt timestamps |
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
| `ai_requests` | технический журнал ИИ и durable paid-operation slots | operation, claim key/state, provider, model, duration, status, error code, tokens, estimated cost |

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

Миграция `031_adaptive_learning_goal_profile.sql` хранит только цель и производные структурированные оценки. Профиль пересчитывается из owner-bound `module_attempts` и проверенных Voice Tutor recovery/repeat записей; тексты ответов, эссе, transcript и audio в adaptive-таблицы не копируются. Клиентский `/module-attempts` не может назначить доверенное происхождение: такие и все прежние строки считаются `client_reported`, дают только слабую предварительную подсказку и не подтверждают mastery. Для расчёта одного навыка учитываются все независимые наблюдения, но не более трёх последних `client_reported` и трёх assisted-наблюдений; без независимого подтверждения mastery ограничен 49, а uncertainty не уменьшается. Навык получает `established` только после двух независимых unassisted/retention наблюдений. Весь профиль получает `established`, только когда подтверждены все 12 навыков, набрано минимум 12 независимых наблюдений минимум в трёх модулях и пройдены общие пороги покрытия/уверенности. Активности сопоставляются с версионированной таксономией только по точным ID/alias; неизвестная обычная активность получает явный fallback своего модуля, а неизвестная агрегатная `exam`-активность игнорируется. Служебные `voice_tutor_*` module attempts не становятся adaptive-наблюдениями: конкретный навык учитывается только из recovery/repeat ledger и поэтому не дублируется в module default. Эти три профильные adaptive-таблицы входят в экспорт владельца и каскадно удаляются вместе с `users`.

Миграция `032_adaptive_short_diagnostic.sql` добавляет owner-bound сессии, immutable start claims и ответы короткой диагностики. Server-owned registry хранит catalog и policy парой и сохраняет `ege-short-diagnostic-v1` как самостоятельную версию: чтение, браузерные лимиты, прогресс, выбор следующего задания, остановка, expiry и итоговый профиль всегда используют `session.catalog_version`, а неизвестная сохранённая версия закрывается ошибкой без подстановки текущих mappings и не получает evidence. Принятые ответы приватно уточняют выбор следующего probe, но не становятся profile evidence до успешного завершения. Каждый успешный start key получает точный снимок сессии, включая key, возобновивший active run; claim живёт не более 24 часов, ограничен 16 живыми claims на владельца и очищается при последующих стартах. Отдельный hourly rate limit применяется до дорогого расчёта overview. Answer idempotency хранит только allowlisted безопасный replay snapshot (`replay_catalog_version`, `replay_status`, `replay_current_item_id`, счётчики, stop reason и timestamps), поэтому повтор возвращает ровно первоначально увиденное состояние даже после следующих ответов или completion. Первый completion в одной mutation сохраняет status/key/hash и `completion_response_snapshot`: только публичный diagnostic DTO, bounded result и allowlisted preliminary profile. Повтор исходного key и другой completion key возвращают этот canonical snapshot до живого пересчёта; отсутствие/повреждение снимка закрывается ошибкой, а конкурентный кандидат не перезаписывает победителя. Claim key/hash и внутренние replay snapshots не экспортируются. Клиент получает безопасную проекцию без answer key и skill mapping и отправляет только `itemId`/`choiceId`. Поля `estimatedMinutes`, `deadlineMinutes`, `maxItems` и `expiresAt` берутся из сохранённой policy; для v1 целевой останов — 10 заданий примерно за 15 минут, жёсткие пределы — 12 заданий и 20 минут. Deadline одинаков для `in_progress` и `ready`, поздние answer/complete не создают evidence. Сохраняются только ограниченные ID, выбранный вариант, server-validated correct flag, явный `evidence_quality`, длительность и timestamps; raw audio, transcript и свободный текст отсутствуют. Replayable local-TTS browser speech у listening items считается `assisted` и получает explanation code `assisted_local_tts_diagnostic`: оно не создаёт independent mastery, не снижает uncertainty и публично помечается как ориентировочная проверка. Любые deep listening choices без реального audio и все Writing/Speaking multiple-choice probes тоже всегда `assisted`: распознавание стратегии не доказывает аудирование, самостоятельное письмо или речь; подтверждение даёт только фактически предъявленная listening-задача или реальная проверенная productive task. Повтор одного server-owned `skill_id:item_id`, в том числе тот же вопрос в short и deep catalog, сохраняется для последующей пользы, но только первое независимое наблюдение этой семьи остаётся strong evidence, а следующие получают `repeated_diagnostic_item`. Только ответы завершённой поддерживаемой версии становятся evidence-наблюдениями; брошенные/истёкшие и неизвестные версии не влияют на профиль. Marker поддерживаемого завершения входит в watermark, поэтому предварительный профиль не требует повторной диагностики. `needsDiagnostic` означает только первоначальную недостаточность evidence. Preview/create (включая replay) закрываются `ADAPTIVE_INITIAL_DIAGNOSTIC_REQUIRED`, пока у нового ученика нет завершённого short marker или достаточного genuine production evidence; плановая повторная диагностика через 4–6 недель показывается отдельно через `retention.rediagnostic.due` и не блокирует занятия. Сессии и ответы входят в экспорт владельца без idempotency fingerprints и внутренних replay snapshots и каскадно удаляются вместе с `users`.

Совместимость с сохранёнными результатами Voice Tutor также версионирована как `voice-tutor-skill-compat-v1`. Явная exact/prefix-карта переводит production-семейства `ege.grammar.topic_*|generated_*`, `ege.word_formation.*`, `ege.collocation.*`, `ege.vocabulary.lexeme_*|generated_*`, `ege.reading.evidence`, `ege.listening.evidence`, writing `writing_37|writing_38|email|essay.criterion.*` и speaking `2|3|4.criterion.*` в поддерживаемые adaptive-навыки. Speaking task 1 (`reading_aloud`) явно распознаётся, но не зачисляется: в `ege-en-v1` нет соответствующего микроскилла. Для известных семейств проверяется допустимый исходный модуль: несовпадение не проваливается в посторонний fallback. Неизвестные recovery/repeat ID также не получают конкретный микроскилл и не могут стать независимым подтверждением; консервативный module fallback разрешён только для обычных module attempts. Внутренний DTO `save/getAdaptiveLearningProfile` одинаков для file/PostgreSQL: содержит только allowlisted профиль с вложенными `estimates`, сортирует их по `skill_id`, нормализует timestamps в ISO и не возвращает owner/backend-only поля. Экспорт использует тот же mapper и разделяет нормализованные profile/estimates без изменения их полей. Цели также проходят через один allowlisted mapper в save/get/API/export обоих backend: внутренние owner/idempotency-поля исключены, а `created_at`/`updated_at` имеют одинаковый ISO/null JSON-вид.

`profile_calculation_revision` отделяет версию алгоритма расчёта от схемы evidence watermark и имеет первый приоритет: новая ревизия может намеренно отфильтровать ранее учитывавшиеся источники, а старая не перезапишет новую даже с большим или более поздним набором. Внутри одной calculation revision append-only `source_count` имеет приоритет над временем: больший backfill принимается даже с прежним/более старым latest timestamp, меньший набор отвергается, а время и затем версия watermark служат детерминированными tie-breaker при равном счётчике. File repository выполняет сравнение внутри своей сериализованной мутации. PostgreSQL держит owner-lock, сравнивает и пишет profile/estimates в одной транзакции, читает готовый allowlisted снимок тем же transaction client до `COMMIT`, затем возвращает уже захваченный DTO. Overview строится только из этого авторитетного результата save, поэтому rejected stale-кандидат не попадает в HTTP-ответ.

PostgreSQL читает attempts/recoveries/repeat attempts одним aggregate SQL statement и тем самым не создаёт orphan repeat между разными `READ COMMITTED` снимками. Profile вместе с 12 estimates также читается одним statement в get, save-before-COMMIT и export, поэтому публичный DTO никогда не смешивает две ревизии.

Миграция `033_adaptive_learning_plan.sql` хранит версионированные owner-bound планы `adaptive-plan-v1`, включая nullable `base_plan_revision` для compare-and-set. План строится прозрачной rule-based формулой из текущей цели и авторитетного profile snapshot: активный диапазон баллов не является гарантией и содержит confidence, assumptions, требуемые минуты и конкретные варианты действий. `requiredWeeklyMinutes` инвертирует ту же capacity-формулу, что и диапазон, включая uncertainty и коэффициент эффективности `0.75`, после чего округляется вверх до пяти минут. `increase_weekly_time` всегда строго больше текущего времени, не превышает 2520 и правдиво сообщает sufficiency/constraint; при уже выбранных 2520 равное «увеличение» не создаётся. Последние дни используют реальную положительную дробь недели. С наступлением/истечением UTC-даты экзамена forecast становится `exam_date_expired`/`action_required`: score range, confidence и requirement равны `null`, weeks — `0`, а единственное действие требует обновить дату. Приоритет микроскилла сочетает разрыв до цели, вес ЕГЭ, due/overdue pressure, относительное усиление high-impact/large-gap навыков при приближении экзамена и uncertainty; высокая uncertainty создаёт `diagnostic_probe`, а не фиктивное mastery. Целочисленные allocations содержат точный канонический набор из 12 навыков и шести модулей, отдельно дают ровно 100%, а module share совпадает с суммой его skills уже на первой ревизии. Обычная следующая ревизия ограничена 10 percentage points на каждый видимый навык и модуль. `overdue` и `critical_due` лимит не снимают; до Ticket 06 единственный разрешённый reset — новая ревизия цели. `critical_retention_expiry` остаётся reason code приоритета, но bypass включится только после появления persisted owner/profile-bound expiry и его repository-side derivation.

Input fingerprint связывает revision цели, profile calculation/watermark/source count, точную `base_plan_revision` и UTC-день пересчёта; он нужен только для идемпотентности и не входит в export/API. File repository сериализует mutation, а PostgreSQL берёт общий owner row lock. В обоих backend полный structural validator и пересчёт fingerprint из supplied outer metadata выполняются до duplicate lookup: один захваченный hash не является replay-запросом, но полный валидный исторический кандидат может вернуть current до проверки текущей цели и профиля. Для новой записи repository в той же owner mutation/transaction заново строит deterministic plan из полной persisted current goal (`target_score`, `exam_date`, `weekly_minutes`), полного profile со всеми 12 skill estimates и current plan. Candidate envelope, forecast, allocation и stability должны точно совпасть с rebuild; synthetic mastery/uncertainty/due-state, goal или shape-valid JSON не сохраняются. Старый конкурентный вектор закрывается `ADAPTIVE_PLAN_PROFILE_STALE`; CAS принимает запись только с фактической текущей базой, а route ограниченно пересчитывает конфликтующий или goal-mismatched результат уже от победившей ревизии. Перед записью repository независимо проверяет лимит ±10 для каждого видимого элемента, разрешая reset только для новой ревизии цели. Порядок plan input сначала сравнивает goal revision, затем общий calculation-first evidence watermark и только затем daily bucket. `PUT /goal` возвращает один согласованный current goal/profile/plan snapshot: `created` относится только к остающейся current ревизии, а `replayed`/`superseded` объясняют старый claim или конкурентную смену. API всегда возвращает авторитетную сохранённую current revision. История планов входит в owner export через общий allowlisted DTO и каскадно удаляется с `users`; свободный текст, raw audio, transcript, эссе и ответы в неё не копируются.

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
