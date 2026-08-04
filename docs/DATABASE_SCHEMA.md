# Схема базы данных

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
| `adaptive_learning_skill_estimates` | структурированные оценки микроскиллов без копий ответов | skill/module, mastery, uncertainty, raw/effective/independent counts, evidence quality, per-skill status, due state and explanation code |
| `adaptive_learning_plan_revisions` | owner-bound история объяснимых прогнозов и недельных распределений | exact base/goal/profile revisions, evidence watermark/count, UTC daily calculation bucket, bounded forecast/allocation/stability JSON, internal input fingerprint and current marker; deterministic `calculatedAt` is derived as bucket start while `created_at`/`updated_at` remain receipt timestamps; duplicate replay additionally requires an exact normalized outer-vector and plan-semantic match, ignoring only regenerated ID and receipt timestamps |
| `adaptive_diagnostic_sessions` | ограниченный по времени запуск короткой адаптивной диагностики | owner, UUID, версия server-owned catalog-policy, статус/current item/счётчики/timestamps и внутренний allowlisted `completion_response_snapshot`, атомарно связанный с completion key/hash; без prompt и answer key |
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
| `speaking_attempts` | журнал пользовательских прогонов устной части | assignment, transcript, review, provider, model, prompt_version, status, error_code; audio is not stored |
| `generated_tasks` | валидированные результаты генерации | operation, versioned request hash, request/result and provider |
| `module_attempts` | нормализованная история учебных результатов | module, activity, score, duration, bounded metadata and server-owned `evidence_quality`; legacy/public writes are `client_reported` |
| `progress_summary` | серверная агрегированная сводка прогресса | attempts, best normalized score, total duration and last attempt |
| `word_progress` | состояние интервального повторения слов | word, stage, errors, reviews and due time |
| `error_bank` | агрегированный банк учебных ошибок | module, item key, type, bounded details and occurrence count |
| `audit_log` | неизменяемый журнал административных действий | actor, action, target, result and bounded metadata |
| `ai_requests` | технический журнал ИИ и durable paid-operation slots | operation, claim key/state, provider, model, duration, status, error code, tokens, estimated cost |

Связи привязаны к `users.username`; API всегда определяет пользователя из HttpOnly-сессии. Изменения схемы добавляются новой нумерованной миграцией и проверяются `npm run db:migrate`.

Миграция `031_adaptive_learning_goal_profile.sql` хранит только цель и производные структурированные оценки. Профиль пересчитывается из owner-bound `module_attempts` и проверенных Voice Tutor recovery/repeat записей; тексты ответов, эссе, transcript и audio в adaptive-таблицы не копируются. Клиентский `/module-attempts` не может назначить доверенное происхождение: такие и все прежние строки считаются `client_reported`, дают только слабую предварительную подсказку и не подтверждают mastery. Для расчёта одного навыка учитываются все независимые наблюдения, но не более трёх последних `client_reported` и трёх assisted-наблюдений; без независимого подтверждения mastery ограничен 49, а uncertainty не уменьшается. Навык получает `established` только после двух независимых unassisted/retention наблюдений. Весь профиль получает `established`, только когда подтверждены все 12 навыков, набрано минимум 12 независимых наблюдений минимум в трёх модулях и пройдены общие пороги покрытия/уверенности. Активности сопоставляются с версионированной таксономией только по точным ID/alias; неизвестная обычная активность получает явный fallback своего модуля, а неизвестная агрегатная `exam`-активность игнорируется. Служебные `voice_tutor_*` module attempts не становятся adaptive-наблюдениями: конкретный навык учитывается только из recovery/repeat ledger и поэтому не дублируется в module default. Эти три профильные adaptive-таблицы входят в экспорт владельца и каскадно удаляются вместе с `users`.

Миграция `032_adaptive_short_diagnostic.sql` добавляет owner-bound сессии, immutable start claims и ответы короткой диагностики. Server-owned registry хранит catalog и policy парой и сохраняет `ege-short-diagnostic-v1` как самостоятельную версию: чтение, браузерные лимиты, прогресс, выбор следующего задания, остановка, expiry и итоговый профиль всегда используют `session.catalog_version`, а неизвестная сохранённая версия закрывается ошибкой без подстановки текущих mappings и не получает evidence. Принятые ответы приватно уточняют выбор следующего probe, но не становятся profile evidence до успешного завершения. Каждый успешный start key получает точный снимок сессии, включая key, возобновивший active run; claim живёт не более 24 часов, ограничен 16 живыми claims на владельца и очищается при последующих стартах. Отдельный hourly rate limit применяется до дорогого расчёта overview. Answer idempotency хранит только allowlisted безопасный replay snapshot (`replay_catalog_version`, `replay_status`, `replay_current_item_id`, счётчики, stop reason и timestamps), поэтому повтор возвращает ровно первоначально увиденное состояние даже после следующих ответов или completion. Первый completion в одной mutation сохраняет status/key/hash и `completion_response_snapshot`: только публичный diagnostic DTO, bounded result и allowlisted preliminary profile. Повтор исходного key и другой completion key возвращают этот canonical snapshot до живого пересчёта; отсутствие/повреждение снимка закрывается ошибкой, а конкурентный кандидат не перезаписывает победителя. Claim key/hash и внутренние replay snapshots не экспортируются. Клиент получает безопасную проекцию без answer key и skill mapping и отправляет только `itemId`/`choiceId`. Поля `estimatedMinutes`, `deadlineMinutes`, `maxItems` и `expiresAt` берутся из сохранённой policy; для v1 целевой останов — 10 заданий примерно за 15 минут, жёсткие пределы — 12 заданий и 20 минут. Deadline одинаков для `in_progress` и `ready`, поздние answer/complete не создают evidence. Сохраняются только ограниченные ID, выбранный вариант, server-validated correct flag, явный `evidence_quality`, длительность и timestamps; raw audio, transcript и свободный текст отсутствуют. Replayable local-TTS browser speech у listening items считается `assisted` и получает explanation code `assisted_local_tts_diagnostic`: оно не создаёт independent mastery, не снижает uncertainty и публично помечается как ориентировочная проверка. Только ответы завершённой поддерживаемой версии становятся evidence-наблюдениями; брошенные/истёкшие и неизвестные версии не влияют на профиль. Marker поддерживаемого завершения входит в watermark, поэтому предварительный профиль не требует повторной диагностики. Сессии и ответы входят в экспорт владельца без idempotency fingerprints и внутренних replay snapshots и каскадно удаляются вместе с `users`.

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
`evaluated_answer`; для `speaking` — лишь completed attempt, сохранённые assignment/transcript и
повторно провалидированный review. Эти данные передаются только в transient provider capsule и не
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
