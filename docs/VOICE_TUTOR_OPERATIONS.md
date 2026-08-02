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
- `VOICE_TUTOR_REQUIRE_ZDR`
- `VOICE_TUTOR_UNBOUND_CREDENTIAL_RISK_ACCEPTED`
- `VOICE_TUTOR_RULE_ALLOWLIST_JSON`
- `VOICE_TUTOR_RULE_SOURCES_JSON`
- `XAI_API_KEY`
- `XAI_ENABLED`
- `XAI_VOICE_ZDR_ATTESTED`
- `XAI_VOICE_MODEL`
- `XAI_VOICE_NAME`
- `XAI_VOICE_CREDENTIAL_TTL_SECONDS`
- `XAI_VOICE_CREDENTIAL_URL`
- `XAI_VOICE_REALTIME_URL`

Versioned voice model/revision обязателен для production; плавающий alias не проходит release
gate. Production startup принимает только immutable xAI voice id вида `grok-voice-…-1.0` или
`grok-voice-…-YYYY-MM-DD`, отклоняет blank/unversioned, а также сегменты
`alias/current/latest/preview/stable` ещё до provider call;
development сохраняет возможность использовать явную fake/test
revision. `XAI_VOICE_NAME` содержит lowercase voice id из provider roster. Credential endpoint должен
принимать только `expires_after.seconds`, а browser E2E обязан подтвердить model query,
`xai-client-secret` subprotocol и первый `session.update`. ZDR attestation означает ручную проверку настроек аккаунта и договорных условий провайдера,
а не только изменение environment flag. Юридический текст обработки голоса несовершеннолетних и
трансграничной передачи — отдельный human gate.

## Direct-credential residual risk

`VOICE_TUTOR_UNBOUND_CREDENTIAL_RISK_ACCEPTED=false` is the fail-closed default. xAI's current
client secret is a short-lived bearer credential: the provider API does not bind it to our
prompt, model, tools or session id and does not expose per-secret revocation. The application
therefore enforces a fixed 60-second credential window, one active reserved session per user,
server-owned validation and a pinned CSP, but these controls cannot constrain a copied bearer
after issuance. An owner must explicitly accept this residual risk before production voice can
be enabled. The accepted architecture and replacement conditions are recorded in
`.scratch/voice-ege-tutor/adr-001-direct-xai-ephemeral.md`.

Feature and cost switches stop new issuance only. They cannot terminate an already-issued
bearer; incident response assumes up to the remainder of its 60-second lifetime. Runtime
provider error, unexpected close or missing `session.updated` acknowledgement closes browser
media and continues the same capsule through text/local fallback. Elapsed voice seconds remain
billable only after the authenticated server activation that follows `session.updated`, and remain
included in aggregate voice-cost metrics. A missing ACK or failed activation bills zero. Browser
audio capture starts only after the activation response; provider/model/prompt provenance remains
attached if delivery later downgrades to text/local.

## Release gate

До включения voice оператор:

1. проверяет актуальную privacy policy/consent version и human ZDR/legal approvals;
2. применяет миграции и проверяет account export/delete на disposable PostgreSQL;
3. запускает `npm test`, `npm run lint`, `npm run check`, `npm run test:postgres`,
   `npm run build:frontend`, `npm run test:e2e`, `npm run security:secrets` и
   `npm run security:history`;
4. подтверждает fake-provider E2E от ephemeral-token request и browser `session.update` через
   authenticated `/activate` до error sheet, micro-check, transfer и recovery map; отдельно проверяет,
   что до activation аудиограф не создан и списание равно нулю;
5. убеждается, что `delivery`, `fallback_rate`, `provider_errors`, voice minutes и estimated cost
   доступны только в агрегированных PII-free admin metrics;
6. получает отдельное owner approval на deploy и только затем снимает feature/cost block.

Автоматические тесты и CI не обращаются к платному Voice API. Реальный smoke не входит в этот
gate и требует отдельного бюджетного разрешения владельца.

## Incident и rollback

При скачке стоимости, provider errors, сомнении в ZDR или privacy incident сначала включается
cost kill switch. Новые voice connections прекращаются, а существующий учебный контекст
продолжается text/local fallback. Затем оператор проверяет агрегированные метрики, pinned model,
credential endpoint, consent version и provider/ZDR status. Основной key не ротируется через
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
