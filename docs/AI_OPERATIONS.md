# Реестр ИИ-операций

## Grammar 2.0 exam 19–24

`grammar_exam_19_24` is a typed `/api/v1/ai/generate-content` operation with the immutable
three-form built-in catalog as its fallback. A successful generated supplement receives six
server-issued owner-bound pointers in the `generated.g.e.<request-hash>.<result-digest>.<position>`
namespace. Completion validation resolves every pointer against that owner's saved generated task;
ordinary `generated.g.q.*` practice pointers, changed topics, revisions or positions fail closed.

Generated exam evidence is always `assisted` and never advances mastery. A built-in exam also cannot
advance mastery: it records bounded history and may regress only the physical topic of an exact wrong
catalog gap. Provider failure therefore keeps the built-in form useful without changing the mastery
or retention contract, and release verification makes no paid provider call.

Успешные результаты типизированной генерации сохраняются для пользователя в `generated_tasks`. Ключ кэша — SHA-256 от валидированного запроса и `CONTENT_PROMPT_VERSION`: новая версия промпта автоматически перестаёт использовать старые записи. Кэш требует авторизацию, активную подписку и согласие на обработку текста, но не расходует внешний ИИ-бюджет.

| Операция | Endpoint | Валидация | Fallback |
|---|---|---|---|
| Проверка задания 37 | `/api/v1/ai/evaluate-writing` | Zod request + server score validation; с 155 слов оценивается официальный фрагмент до целой границы вопроса | локальная проверка объёма |
| Проверка задания 38 | `/api/v1/ai/evaluate-writing` | Zod request + критерии/итоговый балл; с 276 слов оценивается официальный фрагмент до целой границы предложения | локальная проверка объёма |
| Словарная справка | `/api/v1/ai/generate-content` (`dictionary_lookup`) | Zod request + строгий JSON output | мини-словарь |
| Тест по грамматике | `/api/v1/ai/generate-content` (`grammar_quiz`) | Zod request + ровно 5 валидированных заданий | встроенный банк заданий |
| Диалог для аудирования | `/api/v1/ai/generate-content` (`listening_dialog`) | Zod request + вопросы и допустимые индексы ответов | встроенное задание |
| Текст для чтения | `/api/v1/ai/generate-content` (`reading_text`) | Zod request + строгий JSON и 45–70 слов | встроенный текст |
| Словарные карточки | `/api/v1/ai/generate-content` (`vocabulary_cards`) | 4–8 карточек за вызов; точное запрошенное количество; для каждой — исходный и 4 уникальных tracer-ready контекста с точной base-form лексемой | встроенный словарь |
| Генерация задания 37 | `/api/v1/ai/generate-content` (`writing_task_37`) | 40–60 слов, минимум 3 вопроса, тема 2–4 слова | встроенный банк тем |
| Генерация задания 38 | `/api/v1/ai/generate-content` (`writing_task_38`) | 4–5 уникальных строк, целые проценты в сумме 100 | встроенный банк тем |
| Генерация устных заданий 1–4 | `/api/v1/ai/generate-content` (`speaking_task_1`…`speaking_task_4`) | отдельная строгая схема каждого типа, контроль количества слов и элементов | встроенный банк заданий |
| Оценка устного ответа | `/api/v1/ai/evaluate-speaking` | owner-bound session/pronunciation assessment keys; xAI strict JSON Schema возвращает только semantic/language facts, затем versioned server combiner ставит 1/4/5/10; low confidence даёт `needs_retry`, а не ноль | повтор записи; без локального балла |
| Образец устного ответа | `/api/v1/ai/generate-speaking-sample` | типизированное задание, строгий JSON, контроль 4 вопросов/объёма монолога | встроенные подсказки |
| Экзаменационная грамматика, чтение и аудирование | `/api/v1/ai/generate-content` | восемь отдельных операций со строгими структурными проверками | встроенные банки заданий |
| TTS | `/api/v1/tts` | auth, subscription, rate limit, voice allowlist; provider `audio/mpeg`, 1 byte–5 MiB | Web Speech API |
| STT | `/api/v1/stt` | auth, subscription, rate limit, 20 MiB upload; strict provider JSON | повтор записи |
| Voice Error Tutor | `/api/v1/voice-tutor/context-attempts`, `/api/v1/voice-tutor/sessions` | reading/listening сначала сверяют полный завершённый canonical set; writing/speaking возвращают bounded названия и индексы потерянных критериев, затем заново загружают owner-bound completed attempt и валидируют выбранный индекс; transient capsule перечисляет все потери, но одна сессия тренирует один критерий по fail-closed матрице заданий | тот же capsule через AI-text или canonical-local rule; повторная evaluation работы не вызывается |
| Trusted rule evidence | `/api/v1/voice-tutor/rule-discoveries` (`voice_tutor_rule_extract`) | Запрос принимает только owner-bound `session_id` с серверным `rule.discovery_required`; URL только из server allowlist; pinned public DNS address, HTTPS, path, redirects, общий deadline, MIME и bytes ограничены; fetched text передаётся как `untrusted_source_document`, output проходит bounded contract и должен совпасть у двух независимых authority/domain после redirects | один источник, конфликт, blocked URL, уже существующий approved canonical или ошибка fetch/extraction дают fail-closed без новой rule card |

Ответы `reading_questions` и `listening_interview` получают server-issued `voice_tutor.set_id` и
четыре `item_ids`, производные от request hash и digest сохранённого typed result. Shared cache
перед выдачей копируется в owner-bound строку `generated_tasks`. Поэтому встроенные и
динамически сгенерированные результаты проходят один и тот же полный set-level check; устаревшие
локальные наборы без серверного идентификатора исключаются из ротации.

Встроенный словарный каталог содержит четыре отдельные teacher-reviewed английские usage-ситуации
для каждой из 299 лексем; сборщик маскирует целевую лексему и отклоняет пропуск, повтор исходного
примера или post-mask duplicate. Словарный Voice Tutor принимает только наборы, где у каждой AI-карточки есть четыре отдельных
валидированных примера употребления изучаемой лексемы. В micro-check, transfer, day-1 и day-7
правильной остаётся эта же лексема; три близких слова служат только distractors, а позиция правильного
варианта детерминированно меняется для каждой карточки. Ответ принимается и буквой, и самой лексемой.
Top-up запрашивает не более 8 карточек, чтобы пять предложений на карточку помещались в provider
budget 1200 output tokens. Короткий или неполный результат считается `AI_RESPONSE_INVALID`, проходит единственную format-repair/
provider fallback попытку и не сохраняется/не показывается как упражнение без Voice Tutor tracer.

Trusted-rule discovery не даёт браузеру open-web/X search, connectors или произвольный URL.
`VOICE_TUTOR_RULE_ALLOWLIST_JSON` задаёт server-only authority/domain/path policy, а
`VOICE_TUTOR_RULE_SOURCES_JSON` — curated URL для конкретных skill IDs. HTTP redirect не может
выйти из allowlist; DNS проверяется на private/reserved ranges, а разрешённый адрес pin-ится в
HTTPS-запросе. Независимость источников повторно проверяется по конечным URL, authority и domain после
redirects, а единый абсолютный deadline охватывает DNS, redirects и чтение body. Полная страница не
сохраняется. Evidence extractor получает неизменяемые системные
инструкции отдельно от недоверенного документа; результат не исполняет команды и не публикуется
автоматически. Только два согласующихся независимых authority создают `pending_review`, а общий
canonical retrieval видит только `approved`. Расхождения в формулировках согласующихся evidence
сохраняются для reviewer; learner не может передать произвольные skill/title/exam year. Для встроенного
задания без локального правила session response возвращает `discovery_required`; браузер запрашивает
provisional card по owner-bound `session_id` и показывает её маркировку и HTTPS-ссылки в том же разборе.
После одобрения карточка подставляется в новые session capsules как canonical rule без повторного поиска.

## Контракты media-провайдеров

`POST /api/v1/stt` принимает успешный ответ xAI только с `Content-Type: application/json` и
телом не более 64 KiB. JSON должен содержать ровно два поля без дополнительных: строковый `text`,
который после `trim` и NFC-нормализации имеет 1–10 000 символов, и числовой конечный `duration`
от 0 до 300 секунд включительно. Верхняя
граница покрывает самый длинный продуктовый сценарий записи (200 секунд) с запасом, но отсекает
неправдоподобные ответы. Malformed JSON, неверные типы, пустой/слишком длинный текст и duration вне
границ дают существующую публичную ошибку `STT_UNAVAILABLE`; неуспешный HTTP-статус провайдера
по-прежнему даёт `STT_PROVIDER_UNAVAILABLE`. Частичный transcript не возвращается.

`GET /api/v1/tts` принимает успешный HTTP-ответ xAI только с `Content-Type: audio/mpeg` (параметры
заголовка допустимы) и буфером от 1 байта до `TTS_MAX_BYTES`. Значение по умолчанию — 5 MiB,
то есть один ответ занимает не более примерно 2% общего TTS-cache budget 256 MiB; допустимый
операторский диапазон — 1 KiB–50 MiB. Проверяются и объявленный `Content-Length`, и фактически
прочитанный поток. Пустой, слишком большой, HTML/JSON или другой не-MP3 ответ primary-провайдера
не кэшируется и запускает прежний Edge fallback. Edge adapter фиксирован на MP3 и проходит ту же
проверку непустого буфера и размера; если невалиден и он, API сохраняет `TTS_UNAVAILABLE`.
Запись в кэш происходит только после проверки контракта.

Эти правила и локальные тесты доказывают server-owned transport/output-контракты двух media-
операций без платных вызовов. Они не закрывают §24.10 сами по себе: окончательное решение остаётся
за повторным аудитом всех ИИ-операций в отдельном тикете.

Версия prompt для письменной проверки задаётся `WRITING_PROMPT_VERSION` в `ai/writing.js`, для устной части — `SPEAKING_PROMPT_VERSION`, для генерации контента — `CONTENT_PROMPT_VERSION`, для Voice Error Tutor — `VOICE_TUTOR_PROMPT_VERSION`, а для извлечения trusted-rule evidence — полем `promptVersion` операции `voice_tutor_rule_extract`. Версия вместе с операцией, провайдером, моделью, длительностью и результатом записывается в `ai_requests`. Универсального AI proxy в production API нет.

## Speaking semantic facts и детерминированный балл

`speaking-semantic-v4` никогда не принимает assignment или rubric от браузера. Официальные задания
1–4 передают UUID owner-bound session и ключ либо точный набор ключей завершённых pronunciation
assessment. Adaptive Speaking 1–4 uses only a fresh owner-bound task session assigned after the adaptive
execution claim; the old `contentRef + transcript` contract remains rejected. The server restores the pinned catalog/task revision,
проверяет точную привязку owner/session/task/item каждого акустического результата, собирает transcript
из этих результатов и только после этого строит короткий trusted assignment. Transcript помещается
в отдельное поле `untrustedStudentTranscript`; команды внутри него не исполняются.

Для xAI `response_format` фиксирован как strict `json_schema` по официальному structured-output
контракту. Схема не содержит score, criterion maxima или фонетических полей. Дополнительно тот же
ответ повторно проверяется Zod на сервере: bounded строки/массивы, точные 4/5 элементов, task 2
relevance/direct/blocking-error facts, task 3 completeness/appropriateness/phrase facts, task 4
content states и точные непересекающиеся error spans, а также отсутствие дополнительных полей.
Единственная format repair использует ту же строгую схему. Для `evaluate_speaking` fallback отключён:
операция использует только xAI с обязательным strict response format; недоступность провайдера даёт
fail-closed ошибку без деградации на Groq. Официальный контракт xAI: https://docs.x.ai/developers/model-capabilities/text/structured-outputs

`speaking-fipi-combiner-v2` применяет максимумы 1/4/5/10 и полный максимум 20. Одно evidence event
принадлежит одному content/organization/language owner, поэтому один факт не уменьшает два
критерия. Ноль content задания 4 обнуляет все три критерия. Все четыре задания берут только
owner/session-bound Azure facts: task 1 — completeness/fluency и error events; task 2/3 — отдельные
события каждой позиции; task 4 — фонетические события языкового критерия. Omission/insertion не
считаются второй раз phonetic error. Для task 1 грубой ошибкой служит детерминированный приближённый
proxy: omission/insertion либо mispronunciation с `accuracyScore < 50`; отсутствие accuracy у
mispronunciation даёт `needs_retry`. Этот proxy не объявляется методически точным до калибровки.
Partial, `isFinal=false`, низкокачественная или привязанная к другой session/item оценка не доходит
до xAI.

Если semantic/acoustic confidence ниже порога, публичный ответ содержит `got:null`, server-owned
retry verdict, пустые criteria/good/fix и не содержит Voice Tutor pointer. Уверенный результат
сохраняет strict facts и scoring version; перед Voice Tutor сервер заново вычисляет критерии из
сохранённых semantic и bounded normalized acoustic facts всех официальных заданий и отклоняет подмену.

До реального калибровочного набора, двух независимых экспертных оценок, требуемой адъюдикации,
всех quantitative/per-task/subgroup thresholds и внешнего approval точного canonical report digest
API всегда возвращает `automatic_training`, `approximate`, `methodicallyValidated:false`. Offline
порядок и команда описаны в `quality/SPEAKING_CALIBRATION.md`; текущий пустой template не является
release evidence и не включает validated badge.

Tasks 2–3 preserve owner-bound per-item recording durations; one truncated Task 3 answer cannot be
hidden by the aggregate duration. Azure pronunciation events carry the `azure_pronunciation` owner
and an aligned transcript span. A Task 4 span already owned by content, organization, or semantic
language evidence returns `needs_retry` instead of being deducted twice. Canonical attempt replay and
deterministic acoustic preflight occur before the AI budget/rate gates; a new provider-bound claim is
created only after both gates admit the request. A five-minute evaluation claim lease recovers
interrupted pending work exactly once. Every recovery advances a generation, and terminal persistence
uses pending-generation compare-and-set so an old worker cannot overwrite its successor. Transient xAI
failures resume the same attempt and reuse its finalized Azure evidence, while invalid structured output
remains a terminal replay.

`speaking-learning-evidence-v1` is derived only by revalidating the stored deterministic review and its
bounded Azure facts. It publishes separate criterion, word, phoneme, fluency and signal observations. Positive
word-accuracy and phoneme-accuracy aggregates are calculated across the assessed words; fluency is collected
for tasks 1–4, so mastery is not inferred from the absence of an error. Task 4 keeps the official combined
language criterion for the score, but adaptive grammar and lexis are split only by validated semantic issue
codes (`language_grammar`, `language_vocabulary`, `language_register`); the combined score is not copied into
both skills. Assistance is an irreversible server-side flag with a change timestamp on the exact task session;
assisted, technical, partial or low-confidence results remain visible in feedback but cannot increase adaptive
mastery, and post-hoc help advances the evidence watermark so a persisted independent profile is rebuilt. The adaptive
profile and plan use one eligible-source projection for fingerprint, count and latest time; known timestamps are canonicalized
across file/PostgreSQL representations. Plan persistence revalidates the full vector under the owner lock before replay or
insert. If evidence changes after the profile save, the overview retries its complete read-profile-plan cycle instead of
publishing a stale allocation. The report endpoint does not call either provider: Base receives the complete current analysis and 60 monthly assessment minutes;

The complete evidence-profile-plan overview is attempted at most three times, including goal-less and
plan-disabled reads. Exhausted profile CAS, plan save conflict, goal mismatch, goal/profile/evidence stale or
recalculation conflict all return retryable `409 ADAPTIVE_PROFILE_RETRY_REQUIRED` and `Retry-After: 1`;
an older stored profile or plan is never used as a success fallback. Evidence parsing is also fail-closed: scoring fields
must be finite numbers, maxima must be positive, and result flags must be booleans before they can affect mastery
or any watermark component. Numeric-looking or boolean-looking persisted strings are treated as absent evidence.

Premium receives 240 minutes plus longitudinal dynamics, same-task comparison, a targeted-practice pointer
and a bounded Voice Tutor capsule. A lost official criterion keeps precedence. When all official criteria are at
their maximum, the report may instead issue the weakest exact word/phoneme below 80 as a 30-day pronunciation
pointer. The launch endpoint accepts only its stable attempt-bound ref, rebuilds it from the owner attempt and
rechecks both current weakest evidence and expiry; replay after expiry or evidence drift returns a bounded 409.
This coaching pointer carries zero lost points and never changes the official score or mastery. A concrete weak
word or phoneme is also carried as a bounded targeted-practice focus with
an opaque server-issued content reference; assignment revalidates it against the fresh report and restricts the
selector to a different canonical task containing its anchor word. If no such server-owned material exists, the
report exposes the target as unavailable rather than substituting an unrelated task. The exact target is persisted
with the session and evaluation attempt; a later eligible result records `resolved`, `still_needs_work` or
`inconclusive`, so a resolved word/phoneme target is retired. Voice Tutor never changes the official stored result.

## Realtime Voice Tutor boundary

Every create, exact replay, realtime-ticket issue/reissue and text/local recovery re-enters the owner's
serialized repository mutation. After the file owner queue or PostgreSQL user `FOR UPDATE` lock is acquired,
the server takes a fresh authority timestamp and rechecks the whole active Base subscription plus the Premium
Voice Tutor entitlement before returning a session or rotating any credential. A route precheck is therefore
only an early rejection: expiry or revocation committed while the request waits returns 403 and leaves the
stored ticket/nonce unchanged.

For a pronunciation-error capsule, that same mutation reloads and locks the source Speaking attempt and rebuilds
the bounded pointer from its current assistance, mastery, exact word/phoneme ref and 30-day expiry. The route-built
capsule is never sufficient authority. Assistance, ref drift, mastery retirement or the exact expiry boundary
returns the documented bounded 409 before a session, ticket or recovery nonce is created. Official criterion
pointers keep their existing precedence and replay semantics.

The explicit `/fallback` transition uses the same authority boundary before it finalizes status/billing or rotates
the pedagogy nonce. A failed Base/Premium check or stale pronunciation pointer therefore leaves the complete
stored session byte-for-byte unchanged and never reaches the text AI operation. On fresh create, the ticket catch
may enter text/local delivery only for the explicit `VOICE_TUTOR_PROVIDER_UNAVAILABLE` class; authorization,
pronunciation staleness/expiry, session integrity and ticket conflicts propagate as their documented 403/409.
The file reserve path snapshots and restores its whole in-memory state on any failed reservation, so lease expiry
reconciliation cannot leak into a later persistence after a rejected replay; PostgreSQL obtains the same behavior
from transaction rollback.

После auth, Premium entitlement, актуального `voice_processing` consent, quota reservation и
server-owned capsule validation HTTP API выдаёт только одноразовый app ticket, его `expires_at` и
same-origin `proxy_url`. В хранилище остаётся только SHA-256 ticket; idempotent replay предлагает
однократный reissue с тем же Idempotency-Key. Основной xAI key, provider URL, модель, prompt и tools
никогда не передаются браузеру.
Expiry любого initial/recovery/reissue app ticket ограничен `session.expires_at`, включая последнюю
часть сессии, которая короче настроенного ticket TTL.
Provider frames также не пересылаются как raw JSON: proxy удаляет session/config payloads, переводит
ошибки в фиксированный app code и собирает разрешённые lifecycle/audio/caption events только из
явно проверенных полей.

Same-origin WebSocket proxy атомарно consume-ит ticket, заново строит owner-bound capsule и сам
открывает xAI с `Authorization: Bearer XAI_API_KEY`. Только сервер отправляет pinned immutable model,
lowercase voice id, PCM16 little-endian 24 kHz mono JSON transport, `server_vad`, bounded instructions
и единственную функцию `advance_pedagogy`; search/MCP tools запрещены. После provider
`session.updated` proxy ставит `voice_activated_at` и отправляет browser `easyboost.ready`. Только
после этого browser запрашивает микрофон и создаёт audio graph.

Proxy ограничивает handshake/body/frame, JSON/base64 audio, tool output, rate и lifecycle и во время
соединения повторно проверяет feature/cost/ZDR switches, актуальный voice consent, Premium entitlement
и hard deadline. Clean usage считается точно
по наблюдаемым PCM bytes: `ceil((input+output)/48000)`, не выше reservation. Официальный realtime
usage xAI содержит tokens, но не длительность аудио, поэтому abnormal disconnect, timeout, malformed
usage и kill switch консервативно списывают всю reservation. Audio, captions и full transcript не
сохраняются и не логируются; provider/model/prompt и bounded byte/finalization evidence доступны в
account export. Provider error продолжает тот же capsule через text/local fallback.

Browser realtime transport принимает только bounded JSON events, ограничивает bytes и частоту,
требует proxy `easyboost.ready`, затем связанный lifecycle `response.created → response.output_item.added
→ response.function_call_arguments.done → response.done`; response/item/call IDs и tool name
должны совпасть. Несколько объявленных calls обрабатываются в детерминированном порядке, все
function outputs отправляются до ровно одного continuation `response.create`. Повтор, неверный порядок, oversized payload и off-scope tool не
продвигают педагогический FSM; нарушение закрывает поток безопасным фиксированным сообщением.
Capsule и learner-controlled поля помечены в prompt как недоверенные данные, а успех
micro-check/transfer подтверждает только HTTP endpoint с rotating nonce.

Production WebSocket upgrades используют правый валидный `X-Forwarded-For` hop при том же
one-trusted-proxy policy, что Express; minute windows хранят process-local HMAC identities и очищаются
по TTL независимо от capacity. Единый deadline покрывает auth/repository/capsule/provider pipeline;
global/per-user handshake slots удерживаются до repository-backed provider ACK/failure/timeout. Каждая
finalization storage attempt также имеет timeout; PostgreSQL statement/lock deadline завершает или
разрывает текущую попытку до следующего retry, поэтому запросы не перекрываются. В режиме voice каждый
FSM transition требует точный provider call ID; только text/local допускают ручной переход без call.
Потерянный text/local 201 один раз атомарно перевыпускает nonce без повторного AI вызова; partial null
delivery в той же мутации закрывается как zero-billable local. Provisional voice без ticket/activation
либо получает первый ticket вместе с новым nonce, либо при недоступном realtime атомарно становится
zero-billable local.
Primary и bounded finalization PostgreSQL pools имеют PII-free idle-client error handlers: наружу
выходят только фиксированные `code` и `pool`, без raw error, DSN или user data.

Raw audio, полная расшифровка, свободные реплики и временные субтитры не записываются в БД,
account export, application logs, metrics или release evidence. Тесты используют только локальный
fake HTTP+WebSocket provider при выполнении настоящего app/proxy/browser transport; paid smoke разрешён лишь владельцу отдельным
решением вне автоматических gates. Операторский процесс описан в
`docs/VOICE_TUTOR_OPERATIONS.md`.

Для `writing-v8` сервер считает полный объём до вызова провайдера по правилам ФИПИ: числовые
группы и проценты с пробелом, дефисные формы и slash-формы считаются одним словом. В задании 37 серия
из трёх или более подряд одинаковых слов даёт в объём только первое слово, а повторяющиеся
многословные фразы считаются полностью. В задании 38 уже две или более соседние копии одного слова
или одной комбинации слов считаются одним вхождением. Только точные токены дословно скопированного вопроса задания 37 исключаются,
а ученическая вводная фраза или метка перед ними остаётся в объёме. Распознанные заголовки,
подзаголовки и блоки вопроса задания 38 исключаются вместе с их метками. Тот же task-aware normalizer используется браузерным счётчиком, программными фактами,
провайдерным prompt и сохранённым evaluation scope. На 154/275 словах ответ не
усекается; начиная с 155/276 провайдер и программные факты получают официальный оцениваемый фрагмент.
Если формальная граница попадает внутрь вопроса задания 37 или предложения задания 38, общий модуль
либо исключает этот вопрос/предложение целиком, либо включает его до конца при допустимом остатке в
одно слово для задания 37 и одно-два слова для задания 38.
`review.words` и `review.in_range` продолжают описывать полный ответ. Целевой объём для ученика
остаётся `100–140`/`200–250`, но `in_range` и провайдерная K1-логика используют официальные границы
оценивания `90–154`/`180–275`: только ответ короче нижней границы программно получает ноль, а выше
верхней границы оценивается официальный фрагмент до `140`/`250` слов с целой граничной
репликой/фразой. Пользовательская попытка
хранит полный `answer` и отдельный `evaluated_answer`; технический `ai_requests` не хранит ни один
из этих текстов. Для задания 37 оцениваемый текст является единым фрагментом от приветствия до
подписи: начальный структурный конверт письма
(`From`/`To`/`Subject`, самостоятельная дата, почтовый адрес с обязательным номером и следующие за ним строки города/страны) исключается до приветствия или первой
обычной строки, а текст после распознанной завершающей фразы и подписи не оценивается. Слова
`drive`, `road`, `square` и числовое начало внутри прозы остаются словами ответа.
Для задания 38 единый закреплённый опубликованный корпус состоит из темы, всех подписей строк и
процентов таблицы. Точные непрерывные совпадения длиной не менее 10 слов, которые покрывают строго
больше 30% оцениваемого фрагмента, программно обнуляют K1, все остальные критерии и общий балл.

Provider payload, its budget reservation and every durable per-item outcome carry the exact form fingerprint,
authored assignment/content reference, criteria reference/fingerprint and complete pinned criteria snapshot.
Each provisional full-mock item claims its hourly AI slot from the same production provider registry used by
transport: `limitsFor(item.taskType)`. The canonical `writing_37` and `writing_38` ceiling is 12 requests per
owner/hour, further clamped by the active deployment/provider configuration; the unrelated global Writing route
limit is not authority for these durable assessment claims.
The canonical SHA-256 `context_fingerprint` is claimed before each primary, fallback or repair transport and a
replayed claim with a different context is rejected. Recording and replay compare that complete JSON value
semantically (object key order is irrelevant for PostgreSQL JSONB) and fail closed before applying any score if
a value is missing or changed. Public evidence is also executable-contract bounded: at most five items, `kind` is only
`err|warn`, `title` and `note` are non-empty bounded strings, and `wrong`/`right` are bounded strings. The
source-mode service worker preserves the writing normalizer as part of the statically derived EGE executable
dependency closure, so an update cannot leave the runner cached without its shared word-boundary module.

The provider transport receives the prepared outcome UUID as its idempotency key. A transport error or timeout
after any physical-call reservation retains that token as `prepared_unknown`; it is never deleted into an ordinary
retry. If a worker sees `prepared` or `prepared_unknown` after a crash, automatic dispatch first performs only a
non-paying durable provider lookup by that key. A
recovered response is revalidated against the same pinned context and recorded; unsupported or missing recovery
becomes explicit `ambiguous` state and cannot enter the ordinary automatic retry loop. Only the learner's explicit
retry request with `acknowledgePossibleProviderRepeat: true` may atomically tombstone that prepared reservation
and issue a new outcome UUID. The public warning says that provider work may repeat. Old in-progress/failed usage
rows remain counted by the hourly and daily budgets, so uncertainty never creates free calls.

Provider success is the irreversible boundary even if the next claim renewal, result write or usage settlement
fails. The already-durable prepared token immediately becomes non-discardable; a later failure leaves it on the
same lookup-only `prepared_unknown` recovery path, while a process loss leaves the equivalent lookup-only
`prepared` row. Neither state authorizes automatic paid work. Browser persistence, the live word counter and the
server assessment all apply the same browser-safe writing sanitizer before task-aware tokenization, so markup,
invisible controls and line-ending normalization cannot produce different displayed and assessed word counts.
Safe current/attempt/result `GET` routes only read projections and never claim assessment work, reserve budget or
call a provider. After written submission or restore, the browser durably queues the owner-bound idempotent
`POST .../assessment/run`. Its owner-global mutation row binds UUID to the exact operation, attempt and payload.
A pending/in-progress response is `applied:false`, keeps that row resumable and leaves the same browser UUID
queued. A terminal completed/retryable/ambiguous response freezes the exact response snapshot for replay and
retires the command. If the owner lock finds no active subscription and no frozen authorization, it instead stores
`subscription_required` in the authoritative assessment snapshot and returns the same exact terminal disposition.
Every safe current/attempt/result read projects that block, so reload, a second tab or a new device never queues a
replacement automatically. A pending UUID created before that block, or a fresh UUID without `explicitRenewal:true`,
terminalizes with the same disposition even if subscription has since been renewed; neither can dispatch provider
work. The UI renders the subscription-blocked state. Only the learner's explicit action replaces any stale local
automatic command with a new UUID and the marker in its request/hash; the owner-locked begin rechecks current
entitlement and clears the disposition before dispatch. Every assessment/result/disposition mutation advances a
server-owned `assessmentRevision` that is independent from the attempt draft revision and appears in safe reads and
frozen command responses. Browser shared-storage reconciliation compares that revision independently from the draft
revision: a higher assessment projection wins atomically, a lower one is ignored, and an equal revision must be
recursively semantically identical or the runner fails closed without overwriting memory or storage. The same rule
preserves newer assessment state when acknowledging an older immutable terminal replay; the old UUID can still be
retired without regressing the current tab or another restored device. The server permits the exact transition from
`9007199254740990` to JavaScript MAX_SAFE_INTEGER `9007199254740991`; every later assessment mutation fails with
bounded `ASSESSMENT_REVISION_EXHAUSTED` before changing the snapshot or settling the operation ledger. Before applying any
returned current attempt or advancing the queue watermark, the browser
validates the exact `applied`/`replayed` acknowledgement, terminal disposition and attempt/owner/form/timing binding.
A malformed successful HTTP response therefore throws, keeps the previous local state and preserves the same
durable UUID for retry. Explicit retry and ambiguous-repeat acknowledgement remain separate POST mutations.
Task-38 heading exclusion accepts exact pinned topic/row headings and explicit structural heading labels; a
top-of-document isolated heading may use normal heading casing, but an ordinary prose sentence ending in a colon
is counted. The task-37 rule suppresses only an artificial run of three or more copies of the same word, while
task 38 counts two or more adjacent copies of either the same word or the same multiword combination once.
Task-37 counting starts at the greeting and ends with
the signature, excluding a structurally anchored leading From/To/Subject/address/date envelope and any trailing
text after the recognized sign-off/signature pair. For an
overlength answer, `evaluatedWords` records the formal FIPI cutoff (`140` or `250`) while the retained answer keeps
the exact whole-question/whole-sentence boundary. The OpenAPI rubric, scope and completed-total relations are
generated from the pinned rules as finite standard `oneOf` branches: K1 zero admits only the complete zero cascade,
below-shoulder scope admits only that zero rubric, in-band scope binds `evaluatedWords = fullWords`, and overlength
scope binds the formal cutoff. Custom `x-easyboost-*` checks are redundant evidence, not validator authority.

The initial owner-locked claim stores the authorization decision used for provider work: authorization time,
subscription expiry, exact `text_processing` consent decision and consent-policy version. File storage reads the
current consent from the owner record inside its serialized owner mutation; PostgreSQL locks the owner first and
then reads the consent row in the same transaction. A stale caller boolean is ignored, so a revocation that wins
that owner lock wins authorization. New external provider work requires the resulting current subscription and
version-bound consent snapshot. An already-authorized claim may renew, recover and settle after
entitlement expiry under the same owner/attempt/token fence, preventing paid work from being orphaned or repeated.
The browser renders different learner actions for `retryable` and `ambiguous`; the latter requires the explicit
repeat-risk acknowledgement. Both actions persist in the existing offline/reload queue until the HTTP mutation is
acknowledged.

The public automatic-writing contract and complete word/scope policy live in neutral browser-safe shared modules;
`public/` contains only thin adapters and assessment server/domain modules never reverse-import them. The automatic
contract is `mode: experimental`, `scoreKind: approximate`
and one exact warning sentence consumed unchanged by API, editors and every terminal browser state. Internal job storage may retain its
private `provisional` discriminator, but it is never published as the score authority. Expected domain failures
stay quiet; unexpected worker or repository failures are emitted through the existing sanitized logger with only
timestamp, fixed event type, request/attempt identifiers and a bounded safe error code—never learner text,
provider output, stack, credentials or raw error message.

Дневной проектный бюджет задаётся `AI_DAILY_REQUEST_BUDGET` и считается по устойчивому журналу `ai_requests` с начала UTC-суток. Trusted-rule search/extract atomically claim an `in_progress` row before provider transport; global/day and user/operation/hour limits include in-progress and failed attempts, and idempotent settlement records `completed|failed`. При исчерпании API возвращает `AI_BUDGET_EXHAUSTED`. Провайдеры можно аварийно отключить независимо через `XAI_ENABLED=false` или `GROQ_ENABLED=false`, не удаляя ключи.

Если провайдер возвращает usage-метаданные, `prompt_tokens` и `completion_tokens` сохраняются в `ai_requests`. Это позволяет рассчитать стоимость после фиксации моделей и актуальных тарифов без сохранения пользовательских промптов.

Ориентировочная стоимость сохраняется в `estimated_cost_microusd`; тарифы задаются четырьмя переменными `*_INPUT_MICROUSD_PER_MILLION` и `*_OUTPUT_MICROUSD_PER_MILLION`. Повторные словарные запросы кэшируются на `AI_DICTIONARY_CACHE_TTL_MS`; генераторы новых заданий намеренно не кэшируются.

## Банк заданий (раздел 10.1)

Клиент никогда не присылает условие задания — только его идентификатор. Условие сервер
достаёт из таблицы `task_bank` и проверяет, что тип задания совпадает с типом работы.

Порядок выдачи в `POST /api/v1/tasks/next`:

1. Ищется задание нужного типа, которое этот ученик ещё не получал (`task_deliveries`).
   Найдено — выдаётся бесплатно, факт выдачи записывается в той же транзакции.
2. Ничего нового нет — выполняется одна платная генерация. В запрос подставляется список
   уже имеющихся в банке заданий, чтобы модель не выдала копию существующего.
3. Сгенерированное задание сохраняется в банк и становится доступно всем остальным ученикам.

Из-за третьего шага стоимость растёт по числу различных заданий, а не по числу учеников.

## Voice Tutor rule search and clarifications

`voice_tutor_rule_search` вызывает xAI Responses только за structured `url_citation` annotations:
`store:false`, server-owned skill/year, 2–5 allowlisted domains, 15-second deadline and 64 KiB JSON
cap. Из любого большего набора citations сервер выбирает не более пяти URL, сначала по одному на
независимую configured authority, поэтому один search не может исчерпать лимит extract-операций.
Текст ответа модели и URL из prose не используются. Затем `voice_tutor_rule_extract`
обрабатывает bounded fetched documents как untrusted data; две authority обязаны дать одинаковые
claims. Search и extract имеют отдельные per-user rate/budget/log records.
Discovery transport starts only after the owner session atomically claims its active diagnose state
with the current nonce. Card creation rechecks the same claim and nonce, binds the pending card,
rotates the nonce and enters explain in one mutation; finish/delete wins safely and cannot leave an
orphan card. A non-streaming HTTP body is rejected before buffering.

`voice_tutor_text` также обслуживает максимум три transient clarification turns. Learner message
не передаётся repository/log/export, не меняет FSM и ограничен 200 символами; server mutation
вращает nonce и увеличивает только `clarification_turns` до provider call.
До любого provider call операция атомарно создаёт durable `ai_requests` claim, который одновременно
проверяет общий дневной бюджет и персональный часовой лимит. Завершение или ошибка только settle-ит
этот claim; параллельные запросы не могут потратить деньги до учёта слота.

Встроенные задания живут в `public/task-bank.json`. Файл читается сервером при старте
(идемпотентный посев по содержанию) и отдаётся клиенту как часть офлайн-оболочки, поэтому
идентификаторы на обеих сторонах совпадают. Менять идентификаторы в этом файле нельзя:
по ним сервер узнаёт, какую работу он проверяет.
