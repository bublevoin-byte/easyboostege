# Voice Tutor: release и incident runbook

Этот документ относится только к будущему owner-approved release Voice Error Tutor. Он не
добавляет функцию в текущий staging candidate и не изменяет действующий soak.

## Переменные окружения

Deployment inventory хранит только имена переменных; значения и секреты остаются во внешнем
secret store:

- `VOICE_TUTOR_ENABLED`
- `VOICE_TUTOR_COST_KILL_SWITCH`
- `VOICE_TUTOR_COST_MICROUSD_PER_MINUTE`
- `VOICE_TUTOR_DAILY_SECONDS`
- `VOICE_TUTOR_MONTHLY_SECONDS`
- `VOICE_TUTOR_SESSION_SECONDS`
- `VOICE_TUTOR_SESSION_STARTS_PER_HOUR`
- `VOICE_TUTOR_REQUIRE_ZDR`
- `VOICE_TUTOR_PROXY_TICKET_TTL_SECONDS`
- `VOICE_TUTOR_RULE_ALLOWLIST_JSON`
- `VOICE_TUTOR_RULE_SOURCES_JSON`
- `XAI_API_KEY`
- `XAI_ENABLED`
- `XAI_VOICE_ZDR_ATTESTED`
- `XAI_VOICE_MODEL`
- `XAI_VOICE_NAME`
- `XAI_VOICE_HANDSHAKE_TIMEOUT_MS`
- `XAI_VOICE_REALTIME_URL`

Versioned voice model/revision обязателен для production; плавающий alias не проходит release
gate. Production startup принимает только immutable xAI voice id вида `grok-voice-…-1.0` или
`grok-voice-…-YYYY-MM-DD`, отклоняет blank/unversioned, а также сегменты
`alias/current/latest/preview/stable` ещё до provider call;
development сохраняет возможность использовать явную fake/test
revision. `XAI_VOICE_NAME` содержит lowercase voice id из provider roster. Browser E2E обязан
подтвердить same-origin one-use ticket, server Authorization, model query и первый server-owned
`session.update`. ZDR attestation означает ручную проверку настроек аккаунта и договорных условий провайдера,
а не только изменение environment flag. Юридический текст обработки голоса несовершеннолетних и
трансграничной передачи — отдельный human gate.

## Server-owned realtime boundary

The browser never receives an xAI credential, provider URL, prompt, model or tool configuration.
After auth, current voice consent, Premium entitlement and quota reservation, the HTTP API returns
a random one-use application ticket normally valid for 5–60 seconds (30 by default, shorter only at
the reserved session deadline). Only its SHA-256 hash
is stored. An idempotent replay reports `reissue_required`; the same Idempotency-Key can rotate the
ticket and pedagogy nonce exactly once to recover a lost 201 response. Consumed, expired or second-
replacement tickets fail closed; current voice consent and Premium entitlement are checked again
before any replacement is written. Every initial/recovery/reissue ticket expiry is clamped to the
reserved session deadline, including the final configured-TTL window. A lost text/local 201 instead rotates one fallback nonce atomically
without another AI call; a second recovery attempt also fails closed.
If the replacement response itself is lost, the browser repeats that request once with the same key;
the server atomically ends the still-unactivated reservation as zero-bill local delivery, invalidates
the provider ticket, and returns one fallback nonce.
A legacy or partially committed capsule with null delivery is recovered in the same atomic mutation as
zero-billable completed local delivery, so it cannot strand an active quota reservation.
The normal provisional `delivery_mode=voice` row is distinguished by the absence of both an app
ticket and voice activation. An active retry atomically rotates its nonce while issuing the first
ticket; if realtime is unavailable or the reservation was already completed, it instead becomes the
same zero-billable local recovery.

The same-origin WebSocket proxy consumes the ticket atomically, reconstructs the owner-bound source
capsule, and opens xAI Realtime with the server-only `XAI_API_KEY`. The proxy sends the pinned model,
voice, PCM16 24 kHz mono JSON audio, `server_vad`, instructions and only `advance_pedagogy`.
The browser receives `easyboost.ready` only after provider `session.updated`; only then may it request
microphone access. Provider/body frames, browser frames, event rate, lifecycle and audio bytes are
bounded. The feature/cost/ZDR switches, current voice consent, Premium entitlement and the
reserved-session deadline are rechecked throughout the connection and terminate existing proxy
sessions, not merely new issuance.
Provider frames are never relayed verbatim: session/configuration frames are dropped, errors are
translated to a fixed application code, and audio, caption and lifecycle messages are rebuilt from an
explicitly validated field allowlist before they cross the browser boundary.

Upgrade traffic is limited before ticket consumption by remote-IP and authenticated-user budgets.
Production applies the same one-trusted-proxy policy as Express and uses the rightmost validated
`X-Forwarded-For` address. The maps store only process-local HMAC identities and periodically purge
expired one-minute entries independently of capacity. One deadline starts when the global upgrade
slot is acquired, covers authentication, repository/ticket/capsule work and provider setup, and releases
global/per-user slots only on repository-backed provider ACK, failure or timeout. Provider function
calls remain in bounded server memory:
voice delivery requires the HTTP event route to claim the exact call ID and event, complete the
rotating-nonce transition, and authorize one strict `{"accepted":true,"state":...}` output. Text/local
delivery alone may advance without a provider call, and the manual answer form is hidden while voice
is active. A provider response may request only one transition, and automatic continuation cannot
request another until server VAD observes a fresh learner turn. Invented, replayed or unsuccessful
outputs close the connection fail closed.

Confirmed clean completion is billed from observed decoded PCM bytes: `ceil((input+output)/48000)`,
capped by the reservation. xAI currently reports token usage but no authoritative audio duration;
missing, malformed, abnormal, timeout, disconnect or policy-stop evidence therefore charges the full
reservation conservatively. Audio, captions and full transcripts are never persisted or logged.
Provider/model/prompt provenance and bounded byte/finalization fields remain available in account
export; ticket hashes, nonce hashes and reissue counters do not. Before HTTP fallback mutates the
same session, it waits up to 2.5 seconds for an in-flight proxy settlement, preserving already
observed byte evidence without allowing a stalled provider to block fallback indefinitely. Recovery
map responses are `Cache-Control: no-store`. Every finalization persistence attempt has a timeout;
new session creation is also bounded per authenticated user by
`VOICE_TUTOR_SESSION_STARTS_PER_HOUR` (30 by default), including zero-bill fallback reservations.
PostgreSQL applies statement/lock deadlines and destroys a timed-out connection before the proxy may
retry, so attempts never overlap. The proxy retries transient storage failures within a small bounded budget and emits only PII-free
code/reason/attempt telemetry. Failed or hung persistence makes
settlement unsuccessful while durable consumed/unfinalized state preserves conservative recovery.
Both the primary and bounded finalization PostgreSQL pools consume idle-client errors through fixed
PII-free code/pool telemetry, so a database restart cannot become an uncaught process error.
Shutdown stops new upgrades before awaiting work, bounds active and pre-active socket cleanup, and
retains a ten-second process force-exit ceiling. Closing the sheet invalidates pending create,
reissue, discovery and microphone operations; a late reservation is finished without starting media.
The sheet retries creation/reissue network loss at most once with the same idempotency key, displays
remaining session time with a one-shot accessible last-minute warning, and refreshes the visible
quota from the authoritative settlement response.
ADR-002 supersedes ADR-001.

## Release gate

До включения voice оператор:

1. проверяет актуальную privacy policy/consent version и human ZDR/legal approvals;
2. применяет миграции и проверяет account export/delete на disposable PostgreSQL;
3. подтверждает, что внешний HTTPS reverse proxy сохраняет публичный `Host` и передаёт WebSocket
   `Upgrade` для same-origin `/api/v1/voice-tutor/realtime`;
4. запускает `npm test`, `npm run lint`, `npm run check`, `npm run test:postgres`,
   `npm run build:frontend`, `npm run test:e2e`, `npm run security:secrets` и
   `npm run security:history`;
5. подтверждает local fake HTTP+WebSocket provider E2E: one-use app ticket, server Authorization,
   pinned `session.update`, ACK-before-microphone, PCM byte accounting, barge-in, fallback, replay
   rejection, error sheet, micro-check, transfer and recovery map;
6. убеждается, что `delivery`, `fallback_rate`, `provider_errors`, voice minutes и estimated cost
   доступны только в агрегированных PII-free admin metrics;
7. получает отдельное owner approval на deploy и только затем снимает feature/cost block.

Автоматические тесты и CI не обращаются к платному Voice API. Реальный smoke не входит в этот
gate и требует отдельного бюджетного разрешения владельца.

## Incident и rollback

При скачке стоимости, provider errors, сомнении в ZDR или privacy incident сначала включается
cost kill switch. Новые voice connections прекращаются, а существующие proxy sessions закрываются;
учебный контекст
продолжается text/local fallback. Затем оператор проверяет агрегированные метрики, pinned model,
realtime endpoint, consent version и provider/ZDR status. Основной key не ротируется через
браузер или логи; используется отдельный secret-rotation runbook.

Повторное включение допускается после устранения причины, полного fake-provider E2E и нового
human approval. Feature flag можно оставить выключенным без удаления конфигурации и учебных
данных.

## Premium commerce

Paywall вызывает `POST /api/v1/payments/requests` с единственным продуктом `premium_voice`, а
статус читает через `GET /api/v1/payments/requests?product=premium_voice`. Эти endpoints никогда
не выдают доступ сами. Ученик видит bounded первые 8 символов request id и явный статус.
Оператор получает UUID из admin-only очереди
`GET /api/v1/admin/payment-requests?product=premium_voice&status=new`, сверяет оплату вне
приложения и затем под admin-сессией вызывает `POST /api/v1/admin/payment-requests/{id}/resolve`
с `approved` или `rejected`.

При `approved` repository запрещает администратору подтверждать заявку своего Telegram-аккаунта.
Для независимого плательщика сервер атомарно продлевает базовую подписку на 30 дней от более поздней даты
`now/sub_until` и выдаёт `voice_tutor` ровно до нового `sub_until`. Повторный запрос решения
идемпотентен. `rejected` не меняет подписку. Для аварийного отзыва используется
`POST /api/v1/admin/users/{username}/entitlements/voice_tutor/revoke` с пустым JSON-объектом;
базовая подписка при этом сохраняется. Истечение определяется по bounded `ends_at` без ручной
операции. После каждого действия оператор проверяет `/api/v1/me`, `subscription_events` и
`audit_log`, не копируя username или request id в публичный release evidence.

## Квота и каталог упражнений

Каждая новая сессия резервирует меньшее из session limit и положительного остатка суточной и
месячной квоты. Поэтому последние неполные минуты (включая все 600/7200 секунд стандартного
тарифа) доступны, а транзакционная блокировка, idempotency key и уникальная active-session защита
не допускают отрицательных остатков или двойного резерва.

Перед релизом после любого изменения `EGE_WORDS`, `G_BANK` или `G_EXAMS` выполняются
`node scripts/build-core-voice-catalog.js` и затем
`node scripts/build-core-voice-catalog.js --check`. Каталог содержит server-owned reference,
правило и два отличающихся проверочных задания для каждого встроенного ошибочного пути.
Grammar/vocabulary content, полученный от AI, получает opaque pointer только после typed schema
validation и сохранения в `generated_tasks`; браузер не передаёт reference или правило обратно.

## Release evidence

## Complete pedagogical loop

`VOICE_TUTOR_RULE_SEARCH_ENABLED=true` включает production seam xAI Responses `web_search`.
Запрос всегда `store:false`, содержит только server-owned skill/year и 2–5 доменов из
`VOICE_TUTOR_RULE_ALLOWLIST_JSON`. Приложение принимает URL только из structured citation
annotations; из большого ответа выбирается максимум пять ссылок с приоритетом разных configured
authority. Затем повторно применяется HTTPS/domain/path/DNS/redirect/MIME/size policy и требуется
согласия двух независимых authority. Реальные provider-вызовы не входят в автоматические тесты.

Discovery POST принимает owner-bound `session_id` и текущий одноразовый `nonce`. Repository до
любого DNS/provider/fetch atomically переводит активную `diagnose` session в `in_progress` claim.
Параллельный запрос получает bounded conflict; finish/delete делает поздний результат непригодным.
Provisional card создаётся, привязывается и вращает nonce только одной repository-транзакцией,
которая повторно проверяет owner, active state, claim и исходный nonce. Failure получает
наблюдаемый `failed` status; orphan card не создаётся. FSM затем переходит в `explain`, но карточка
остаётся `pending_review` и недоступна другим ученикам. Три `clarify|explain_differently` turn меняют только счётчик и nonce: текст живёт лишь
в provider request. Server-VAD `speech_started` останавливает все queued browser audio sources и
отправляет `response.cancel`/`conversation.item.truncate`; повторный/off-order audio закрывает
transport и запускает существующий fallback.

Learner feedback принимает только четыре structured reason. Администратор проверяет очередь
`GET /api/v1/voice-tutor/reports?status=pending` и фиксирует `confirmed|dismissed`; свободный текст,
аудио и transcript в report отсутствуют. Перед включением search проверяются feature flag,
allowlist, AI budget/rate metrics и очередь pending rule/report cards.

Каждый платный `voice_tutor_rule_search`/`voice_tutor_rule_extract` сначала атомарно занимает
durable `ai_requests` slot с idempotent claim key. Global UTC budget и per-user/hour limit считают
также `in_progress` и failed attempts, поэтому параллельность не усиливает расход. Provider
вызывается только после успешного claim; settlement `completed|failed` идемпотентен.

Evidence может содержать commit SHA, время, список выполненных команд, их exit code, версии
миграции/schema, bounded public error code и агрегированные PII-free metrics. Evidence не должно
содержать environment values, provider keys/credential, headers, raw provider payload, username,
session/capsule/task ids, learner answer, аудио, caption, transcript или свободную реплику.
