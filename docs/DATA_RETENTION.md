# Жизненный цикл данных

| Данные | Хранение | Удаление |
|---|---|---|
| Коды Telegram и истёкшие сессии | только до использования или истечения срока | удаляются автоматически при обращении к хранилищу |
| Учебный прогресс и банк ошибок | пока существует аккаунт | каскадно удаляются по подтверждённому запросу владельца |
| Журнал пользовательских прогонов: задания, полные и фактически оценённые ответы, транскрипты, разборы, статусы отказов и происхождение модели | пока существует аккаунт; входит в экспорт пользователя | каскадно удаляется по подтверждённому запросу владельца |
| Аудио устной части | не сохраняется в базе | временный файл удаляется после обработки |
| Заявки, подписки и события оплаты | пока существует аккаунт | удаляются вместе с аккаунтом |
| Premium-entitlements, исходная bounded-ошибка и структурированные результаты Voice Tutor | пока существует аккаунт; нормализованный ошибочный ответ входит в учебный журнал исходных попыток, а evaluated writing text/speaking transcript остаются только в уже существующих журналах evaluation; ни один из них не копируется в Voice Tutor session или её export; аудио и временные субтитры отсутствуют | удаляются вместе с аккаунтом |
| Карта восстановления Voice Tutor и day-1/day-7 повторы | пока существует аккаунт; только skill/rule/session/task ids, pass flags, UTC timestamps, bounded potential points и SHA-256 idempotency fingerprint; отправленный ответ, аудио и transcript не сохраняются | экспортируется владельцу без fingerprint и каскадно удаляется вместе с аккаунтом |
| Цель ЕГЭ и адаптивный профиль | пока существует аккаунт; цель и её created/updated timestamps, версии таксономии/взвешивания/watermark, ревизия алгоритма расчёта, последнее время и append-only число source events, mastery/uncertainty, raw/effective/independent счётчики, provenance class, per-skill status, server-derived nullable critical retention expiry, число подтверждённых навыков и reason codes; исходные ответы, эссе, transcript и audio не копируются | история целей и структурированные оценки экспортируются владельцу в общем для file/PostgreSQL allowlisted ISO/null JSON-виде и каскадно удаляются вместе с аккаунтом |
| Ревизии персонального плана ЕГЭ | пока существует аккаунт; версия алгоритма, ссылка на цель и `base_plan_revision`, evidence watermark/count, дневной recalculation bucket, активный диапазон либо action-required marker истёкшей даты, bounded reason codes и процентное распределение; внутренний input fingerprint не экспортируется; critical bypass сохраняет только reason и server-verified skill/module IDs из persisted expiry | allowlisted ревизии экспортируются владельцу по порядку и каскадно удаляются вместе с аккаунтом; тексты ответов, эссе, transcript, audio и обещание балла не сохраняются |
| Короткая адаптивная диагностика и Premium Deep | сессии и минимизированные ответы — пока существует аккаунт; Free short ограничивается одним завершённым запуском, deep требует Premium; start claims — не более 24 hours, максимум 16 живых claims на владельца и с очисткой expired claims; durable claims содержат key/hash и immutable start snapshot, response rows — внутренний allowlisted answer replay snapshot, completed session — allowlisted completion replay snapshot с diagnostic DTO, bounded result и preliminary profile; prompt, answer key, свободный текст, raw audio и transcript не сохраняются | сессии и ответы экспортируются владельцу без idempotency fingerprints и внутренних replay snapshots; start claims и completion snapshot не экспортируются отдельно; все категории каскадно удаляются вместе с аккаунтом |
| Адаптивные учебные сессии и события исполнения (commercial scope и reports) | пока существует аккаунт; версия сессии и composer/content/taxonomy/launch, `commercial_scope=free_demo|base|premium`, ссылка на неизменяемую ревизию плана, UTC-неделя, длительность, структурированные блоки с opaque server-owned content ref и строгим allowlisted launch descriptor, bounded completion summary, status/position, одна bounded-причина замены и append-only события block/finish с source reference, evidence provenance/context и минутами; Premium detailed report — производная проекция не более 12 completion summaries, а не новая копия ответов; retention-блок содержит только существующие repeat/task/skill/module IDs и UTC window, без prompt/answer; без исходных ответов, эссе, transcript и audio; также без score или model response. Execution claims живут не более 2 часов и хранят только hash token; start mutation snapshot хранит UUID claim, но не bearer, который при точном replay реконструируется серверным HMAC; owner-global mutation keys/hashes/snapshots — внутренние | allowlisted сессии, summaries, производная `adaptive_learning_reports` и события экспортируются владельцу без claim/token/idempotency hashes/snapshots и каскадно удаляются вместе с аккаунтом |
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

Клиентские `module_attempts` не являются источником Writing/Speaking: ordinary API отклоняет эти модули,
а расчёт профиля ревизии 2 не учитывает прежние `client_reported` writing/speaking строки даже в evidence
watermark. Для этих разделов используются только уже существующие completed server-assessed writing и
speaking reviews; тексты и transcript в сводку или её offline cache не копируются.

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
