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
| `module_attempts` | нормализованная история учебных результатов | module, activity, score, duration and bounded metadata |
| `progress_summary` | серверная агрегированная сводка прогресса | attempts, best normalized score, total duration and last attempt |
| `word_progress` | состояние интервального повторения слов | word, stage, errors, reviews and due time |
| `error_bank` | агрегированный банк учебных ошибок | module, item key, type, bounded details and occurrence count |
| `audit_log` | неизменяемый журнал административных действий | actor, action, target, result and bounded metadata |
| `ai_requests` | технический журнал ИИ и durable paid-operation slots | operation, claim key/state, provider, model, duration, status, error code, tokens, estimated cost |

Связи привязаны к `users.username`; API всегда определяет пользователя из HttpOnly-сессии. Изменения схемы добавляются новой нумерованной миграцией и проверяются `npm run db:migrate`.

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
