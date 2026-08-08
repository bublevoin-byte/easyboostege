# Жизненный цикл данных

## Speaking pronunciation assessments

The quota/billing ledger is retained while the account exists. It contains locale, state, reserved/billable seconds, bounded server-owned task/session context, normalized transcript/scores/word timing/phoneme facts, provider/version provenance, release or interruption reason, and UTC reservation/dispatch/provider-start/settlement timestamps. A pre-start release retains only its bounded canonical outcome for exact replay; a stale dispatch or post-start recovery retains the bounded conservative settlement. It never stores the audio bytes or full provider payload. User export includes the allowlisted context, normalized assessment and billing facts but omits the idempotency key and request fingerprint. Account deletion removes file-ledger rows and PostgreSQL rows cascade from `users`.

## Speaking accent calibration

The accent profile and its append-only revision history are owner-bound and retained while the account
exists. Every new Speaking session snapshots locale, profile revision and effective time; a later manual
change does not rewrite existing sessions or assessment evidence. The one-time “unknown” setup stores only
two finalized assessment keys with one identical SHA-256 audio digest and its bounded suggestion metadata,
never a second copy of the audio. The digest cannot reconstruct the recording.

Research calibration has a separate voluntary consent record. It is not the ordinary training consent,
and declining or revoking it does not restrict training. A granted minor consent requires guardian
confirmation. Consent can still be read or revoked after subscription expiry. A deliberately contributed
PCM WAV is accepted only when its digest matches the finalized assessment and is retained only for two
independent sufficient blinded ratings. The sample also retains one bounded immutable server-owned task and rubric snapshot,
so a later catalog deployment cannot change or strand the expert card; these public materials contain no learner data;
a material disagreement temporarily retains it for a third adjudication. Raw audio is actually deleted
after the agreeing pair or adjudication, immediately on consent revoke, or at latest after 180 calendar days.
The deadline is enforced on queue claim, audio read and review submission; an active reviewer lease never
extends it.
Owner export includes the profile/history, consent and allowlisted sample lifecycle metadata but excludes
audio, assessment keys, reviewer identities, ratings and access audit. It also includes allowlisted setup lifecycle metadata
(`id`, state and timestamps, locale/confidence/policy when completed) but never the two internal evidence keys.
Account deletion removes unfinished
owner-bound samples and audio. Completed anonymous labels may survive only without owner, assessment key,
reviewer identity or raw audio. Deleting an expert also removes that identity from retained ratings and
access leases, leaving only a reviewer-account-deleted marker on anonymous completed labels.

## Speaking learning report and assistance provenance

No separate learning-report row is stored. Base and Premium views are rebuilt on each request from at most
120 owner-bound `speaking_attempts` after deterministic review revalidation. The source session/task/catalog
revision, attempt `accent_locale`, bounded target snapshot (`sourceAttemptId`, `reportRevision`, `accentLocale`,
skill/content references and optional word/phoneme focus),
the task-session monotonic `assistance_used` marker and the attempt-level `assistance_updated_at` timestamp are retained with the
account, included in the owner's allowlisted export, and cascade on account deletion. The bounded positive
word/phoneme averages and per-task fluency score are normalized assessment aggregates; no list of correctly
spoken words, audio or raw provider payload is added. Premium dynamics, comparisons, unavailable-target reasons,
target outcomes, targeted-practice advice and the Voice Tutor pointer are projections and are not cached in the
browser or copied into adaptive storage. When every official criterion is at its maximum, the Premium projection
may point to the weakest exact word/phoneme below 80 instead. That bounded pointer contains only the attempt/task,
accent, stable word/phoneme ref and label, score summary, observation time and a 30-day expiry; it never changes the
official score or mastery. A started Voice Tutor session persists only the existing `voice-tutor-reference-v1`
capsule reference with that exact ref. It remains in the owner's allowlisted Voice Tutor export and follows the
same session retention and account-delete cascade; no new transcript, provider payload or audio copy is created.
Reservation, exact replay and credential recovery re-read that existing source attempt under the owner lock only
to rebuild the capsule; this validation creates no new retained copy or export category.
Outcomes are reproducibly derived from the exact persisted target and
the later canonical review. They are projected for reliable, assisted, technical and low-confidence attempts;
the latter three remain explicitly `inconclusive` and never become mastery or trend evidence. Pronunciation
retirement and dynamics are isolated by accent locale and evaluated in chronological order, so a later regression
reactivates an earlier resolved target without mixing `en-GB` and `en-US` evidence.
Both tiers receive the same bounded 120-entry attempt timeline and actionable next step; Premium alone receives
comparisons, detailed dynamics, targeted-practice and Voice Tutor projections. Empty history still returns the safe
`start_official_attempt` next step. Premium mining scans at most 480 recent pronunciation events, retains at most
240 candidate targets and exposes at most 20 unavailable targets. Base returns before this mining work and uses a
pre-indexed server-owned material catalog for its bounded next step.

Authorization is rechecked under the owner lock before this projection is built or a targeted session is inserted.
If the Base subscription has expired, the request returns `403 SUBSCRIPTION_REQUIRED`; no report payload is exposed,
no targeted session is retained and no new retention category is created. A Premium-only expiry with active Base
access merely removes the Premium projection and preserves the ordinary report history.

The adaptive profile uses the same hard newest-120 Speaking source bound before hydration and hashing. PostgreSQL
limits the ordered owner rows before JSON aggregation; file storage slices before mapping; the domain projection
defensively caps again before expanding skill observations. Transcript, assignment and provider metadata are not
loaded for this adaptive read. Older attempts are not deleted or rewritten and remain covered by the ordinary owner
export/deletion contract; only the derived adaptive evidence window is bounded, so no data migration is required.
Adaptive storage receives only criterion/diagnostic/aggregate skill observations and provenance from eligible
unassisted evidence, never the transcript, individual word events, report or Voice Tutor context.
The Premium pronunciation target contains only one bounded word/phoneme label, its anchor word, source attempt
number and canonical task references. It is retained only as the immutable target snapshot on the selected
task session and resulting attempt, not as a separate report record.

| Данные | Хранение | Удаление |
|---|---|---|
| Коды Telegram и истёкшие сессии | только до использования или истечения срока | удаляются автоматически при обращении к хранилищу |
| Учебный прогресс и банк ошибок | пока существует аккаунт | каскадно удаляются по подтверждённому запросу владельца |
| Журнал пользовательских прогонов: server-owned задания, полные и фактически оценённые ответы, транскрипты, strict semantic facts, versioned deterministic разборы/баллы, bounded normalized acoustic facts заданий 1–4, статусы retry/отказов и происхождение модели | пока существует аккаунт; входит в экспорт пользователя; raw xAI/Azure payload и audio не сохраняются | каскадно удаляется по подтверждённому запросу владельца |
| Аудио устной части | не сохраняется в базе | временный файл удаляется после обработки |
| Сессии тренировки Speaking 1–4 | пока существует аккаунт; сохраняются только server-owned catalog/task revision, причина ротации, статус, позиционный прогресс для заданий 2–3, длительность, mic-check/local-playback/self-rating и UTC timestamps; оригинальные фотопары задания 4 являются статическими публичными assets; audio, transcript, score и свободный ответ не принимаются и не сохраняются | безопасные metadata-сессии входят в экспорт владельца без `username` и каскадно удаляются вместе с аккаунтом; локальный browser audio освобождается при перезаписи, уходе с экрана или закрытии вкладки |
| Полный устный раздел | пока существует аккаунт; закрепляются совместимые catalog/task revisions четырёх заданий, официальный прогресс 1+4+5+1, server deadlines, bounded recording status/duration/mic-check/technical issue metadata и canonical submission с максимумом 20; несовместимая попытка сохраняется как `abandoned`, просроченный ответ — как `response_timeout`; audio, transcript, score, ответ, rubric и analysis не принимаются и не сохраняются | metadata-сессии, включая безопасно заменённые, экспортируются владельцу без `username` и внутреннего submission key и каскадно удаляются вместе с аккаунтом; browser audio остаётся локальным, доступно для прослушивания только после submit и освобождается при уходе с экрана |
| Заявки, подписки и события оплаты | пока существует аккаунт | удаляются вместе с аккаунтом |
| Premium-entitlements, исходная bounded-ошибка и структурированные результаты Voice Tutor | пока существует аккаунт; нормализованный ошибочный ответ входит в учебный журнал исходных попыток, а evaluated writing text/speaking transcript остаются только в уже существующих журналах evaluation; ни один из них не копируется в Voice Tutor session или её export; аудио и временные субтитры отсутствуют | удаляются вместе с аккаунтом |
| Карта восстановления Voice Tutor и day-1/day-7 повторы | пока существует аккаунт; только skill/rule/session/task ids, pass flags, UTC timestamps, bounded potential points и SHA-256 idempotency fingerprint; отправленный ответ, аудио и transcript не сохраняются | экспортируется владельцу без fingerprint и каскадно удаляется вместе с аккаунтом |
| Цель ЕГЭ и адаптивный профиль | пока существует аккаунт; цель и её created/updated timestamps, версии таксономии/взвешивания/watermark, ревизия алгоритма расчёта, последнее время, число и SHA-256 fingerprint единой проекции только допустимых source events, mastery/uncertainty, raw/effective/independent счётчики, provenance class, per-skill status, server-derived nullable critical retention expiry, число подтверждённых навыков и reason codes; исключённые client-reported productive/unsupported события не меняют ни одну часть watermark; исходные ответы, эссе, transcript и audio не копируются | история целей и структурированные оценки экспортируются владельцу в общем для file/PostgreSQL allowlisted ISO/null JSON-виде и каскадно удаляются вместе с аккаунтом |
| Ревизии персонального плана ЕГЭ | пока существует аккаунт; версия алгоритма, ссылка на цель и `base_plan_revision`, полный profile evidence watermark/count/time/content fingerprint, дневной recalculation bucket, активный диапазон либо action-required marker истёкшей даты, bounded reason codes и процентное распределение; внутренний input fingerprint не экспортируется; critical bypass сохраняет только reason и server-verified skill/module IDs из persisted expiry | allowlisted ревизии экспортируются владельцу по порядку и каскадно удаляются вместе с аккаунтом; тексты ответов, эссе, transcript, audio и обещание балла не сохраняются |
| Короткая адаптивная диагностика и Premium Deep | сессии и минимизированные ответы — пока существует аккаунт; Free short ограничивается одним завершённым запуском, deep требует Premium; start claims — не более 24 hours, максимум 16 живых claims на владельца и с очисткой expired claims; durable claims содержат key/hash и immutable start snapshot, response rows — внутренний allowlisted answer replay snapshot, completed session — allowlisted completion replay snapshot с diagnostic DTO, bounded result и preliminary profile; prompt, answer key, свободный текст, raw audio и transcript не сохраняются | сессии и ответы экспортируются владельцу без idempotency fingerprints и внутренних replay snapshots; start claims и completion snapshot не экспортируются отдельно; все категории каскадно удаляются вместе с аккаунтом |
| Адаптивные учебные сессии и события исполнения (commercial scope и reports) | пока существует аккаунт; версия сессии и composer/content/taxonomy/launch, `commercial_scope=free_demo|base|premium`, ссылка на неизменяемую ревизию плана, UTC-неделя, длительность, структурированные блоки с opaque server-owned content ref и строгим allowlisted launch descriptor, bounded completion summary, status/position, одна bounded-причина замены и append-only события block/finish с source reference, evidence provenance/context и минутами; Premium detailed report — производная проекция не более 12 completion summaries, а не новая копия ответов; retention-блок содержит только существующие repeat/task/skill/module IDs и UTC window, без prompt/answer; без исходных ответов, эссе, transcript и audio; также без score или model response. Execution claims живут не более 2 часов и хранят только hash token; start mutation snapshot хранит UUID claim, но не bearer, который при точном replay реконструируется серверным HMAC; owner-global mutation keys/hashes/snapshots — внутренние | allowlisted сессии, summaries, производная `adaptive_learning_reports` и события экспортируются владельцу без claim/token/idempotency hashes/snapshots и каскадно удаляются вместе с аккаунтом |

The two-hour execution-claim TTL starts from a fresh authority timestamp sampled only after the file owner queue or
PostgreSQL user lock is acquired. The stored claim and locked start replay snapshot use the same issued/expiry pair;
all claim-consuming bind/repeat/advance paths re-read current authority time after that boundary. This changes no
retention class or export shape and needs no migration; it prevents queued requests from extending claim lifetime.
| Reading 2.0 report | отдельная запись отчёта не хранится: Base/Premium проекция строится на запросе не более чем из 120 последних owner-bound `module_attempts`, прошедших строгую проверку canonical catalog ID/revision/provenance и полноты логической попытки; исходные ответы, тексты заданий, Voice context и отчёт в localStorage не копируются | исходные `module_attempts` уже входят в экспорт и каскадно удаляются вместе с аккаунтом; после удаления владельца отчёт нечего проецировать |
| Найденные rule cards | bounded нормализованное правило, skill/год, URL, retrieval time, content hashes, status и review audit; fetched страницы не сохраняются | созданные владельцем pending/rejected reports удаляются вместе с аккаунтом; approved canonical сохраняется без creator identity, а identity удаляемого reviewer обезличивается в оставшихся карточках |
| Сообщения ученика о Voice Tutor | session/rule IDs, одна из четырёх причин, status и admin review audit; свободный текст, audio и transcript не принимаются | экспортируются владельцу и каскадно удаляются вместе с аккаунтом |
| Административный аудит | сохраняется как история решения | при удалении аккаунта `username` удаляется из metadata, остаётся только обезличенный факт действия |
| Резервные копии | 14 дней локально, 30 дней во внешнем хранилище | удаляются заданиями retention |

Удаление аккаунта выполняется транзакционно; file storage также сериализует удаление с Voice Tutor
и rule-card mutations и запрещает новые creator-owned reports после удаления owner. Новые категории персональных данных нельзя
добавлять без обновления экспорта, удаления, этой таблицы и соответствующих тестов.

Браузер хранит только bounded handoff активного адаптивного блока: username владельца для локальной
изоляции, owner-opaque session/block/activity
references, execution claim, CAS revision, точную очередь `attempt → bind → advance` и не более одной
durable control-операции `start|break|finish|recovery` с её UUID idempotency key и структурированным телом. `recovery`
хранит только вернутую сервером exact attempt reference и доводит потеряный `advance` без второго claim/попытки. Запись
ограничена 30 КБ и автоматически удаляется не позднее 3 часов, при смене/выходе/удалении аккаунта,
при повреждённой структуре и при terminal 4xx.
Офлайн-завершение остаётся pending и не показывается выполненным до успешной записи существующей
попытки и server-confirmed advance; исходный учебный ответ в handoff не копируется. Для
`voice_tutor_recovery` браузер держит ответ только в поле формы до существующего repeat POST;
adaptive localStorage получает лишь UUID сохранённой попытки. Для adaptive repeat минимизированная
attempt-запись и consumption execution claim коммитятся атомарно; несовпадающий по launch
repeat/task/window ответ не остаётся в ledger.

Офлайн-очередь общего прогресса хранится отдельно для каждого локального owner. Небезопасная
глобальная очередь версии 2 удаляется при определении владельца и не переносится автоматически;
ответ незавершённой синхронизации может очистить только отправленные значения того же owner.

Обычная завершённая словарная сессия без adaptive claim может временно хранить owner-bound очередь
не более чем из 20 module-attempt summaries до восстановления сети. Одна запись ограничена 20 000
символов, содержит UUID сессии, фиксированные mode/evidence counters и длительность, но не слова,
ответы, prompt, transcript или audio. Первый payload для UUID имеет приоритет, повторная синхронизация
идемпотентна; terminal 4xx удаляет непринимаемую запись. Очередь недоступна другому локальному owner
и явно удаляется вместе с аккаунтом.

Reading-отчёт намеренно не имеет offline-кэша успешного Premium payload. Каждый новый запрос
повторно проверяет активную подписку и актуальный `voice_tutor` entitlement на сервере. При неизвестном
сетевом состоянии клиент не считает Premium отозванным, но удаляет прежнюю проекцию и предлагает
повторить запрос; подтверждённый сервером revoke/expiry немедленно возвращает Base-проекцию.

Клиентские `module_attempts` не являются источником Writing/Speaking: ordinary API отклоняет эти модули,
а расчёт профиля ревизии 2 не учитывает прежние `client_reported` writing/speaking строки даже в evidence
watermark. Для этих разделов используются только уже существующие completed server-assessed writing и
speaking reviews; тексты и transcript в сводку или её offline cache не копируются.

Повреждённые или legacy evidence-поля не исправляются неявным приведением типов. Строки, похожие на
числа или boolean, `null`, пустые значения, нечисловые значения и неположительный максимум не входят
в mastery, evidence count, latest timestamp или fingerprint. Исходная owner-bound запись может оставаться
в своём обычном сроке хранения и экспорте, но не становится учебным свидетельством. File и PostgreSQL
используют одинаковую fail-closed проекцию; это правило целостности данных, а не новая категория хранения.

Persisted `voice_tutor_sessions.capsule` — только reference schema: capsule/source/module/skill IDs,
revision/version и, при необходимости, `rule_card_id`. Prompt, reference,
learner answer, rubrics и answer arrays каждый раз реконструируются из owner-bound source attempt
и canonical server catalog. Миграция 027 минимизирует старые capsule без копирования их текста,
а миграция 028 удаляет прежний `content_hash`, чтобы не хранить fingerprint ответа ученика.
`clarification_turns` хранит только число 0–3. `voice_tutor_reports` хранит UUID session/rule,
structured reason/status и admin audit; learner free text не принимается. Обе категории входят в
экспорт владельца и каскадно удаляются вместе с аккаунтом.

Discovery state хранит только UUID claim, status и timestamps/error code, без найденной страницы,
prompt или ответа ученика. Durable AI slot в `ai_requests` хранит bounded operation/provider/model,
claim key, terminal status и технические usage/cost fields; failed slots сохраняются как
наблюдаемые технические попытки и не содержат prompt, document body или learner answer.

Realtime Voice Tutor обрабатывает аудио потоково через server-owned proxy только после актуального
`voice_processing` consent и `voice_activated_at`, выставленного proxy после provider ACK.
Этот timestamp и bounded PCM byte/finalization evidence входят в структурированный session export;
до ACK browser не запрашивает микрофон и quota не списывается.
Сервис не пишет raw audio, полную расшифровку или временные субтитры
в БД, экспорт, application logs, метрики и release evidence. Отзыв согласия запрещает выдачу новых
app tickets и завершает активный proxy; удаление аккаунта транзакционно удаляет структурированные session/recovery/repeat
записи и неутверждённые rule reports; approved canonical остаётся только как неперсональная база знаний.

Журнал прогонов не является анонимным: свободный ответ или транскрипт сам может содержать имя,
контакты и другие персональные сведения. Он не импортируется автоматически в золотой набор.
Любая будущая исследовательская выгрузка требует отдельной псевдонимизации идентификатора,
очистки свободного текста от персональных данных и отдельной человеческой разметки; простая
замена `username` псевдонимом для этого недостаточна.

## Локальный offline snapshot персонального плана

Persisted adaptive plan revisions retain the canonical SHA-256 fingerprint of the exact profile-evidence snapshot
used to calculate them. The fingerprint contains no learner answer, transcript or audio, is included in owner
export, and is deleted with the plan history on account deletion. Legacy revisions written before migration 052
remain readable with a null fingerprint and are superseded by the next authoritative recalculation.

Браузер может хранить не более 24 часов и 120 000 символов последней успешной публичной проекции
`goal/profile/plan/retention/access`. Snapshot версионирован, привязан к текущему owner из
`eb_current`, не содержит execution claim, idempotency key, ответы, prompt, transcript или audio и
используется только для read-only отображения при сетевой ошибке. Повреждённая, просроченная,
слишком большая, будущая либо принадлежащая другому owner запись удаляется fail-closed. Logout и
удаление аккаунта явно очищают snapshot.

Экран прогресса читает из этого же snapshot сводку шести разделов, не создавая отдельную копию
профиля. При fallback он показывает timestamp сохранения и явную метку, что это сохранённая,
возможно не свежая копия; online-актуальность из cache не выводится.

`adaptiveLearning` в технических метриках — вычисляемый PII-free aggregate, а не сохранённая копия
learner data. Он содержит только фиксированные buckets/counters/rates; username и любые owner,
session, attempt, skill identifiers или свободный текст не публикуются.
