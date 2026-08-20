# Полный пробник ЕГЭ: выпуск и эксплуатация

## Граница релиза

Первый выпуск содержит ровно один проверенный авторский вариант
`ege-en-2026-form-1@1`. Его identity и fingerprint неизменяемы: исправление содержания
оформляется новой ревизией, а не заменой уже начатого варианта. Письменная часть длится
ровно 190 минут, устная — отдельно 17 минут. Оба дедлайна задаёт сервер; reload,
offline и последующий reconnect их не сдвигают.

Старт требует сети и успешного preflight всех immutable assets. Уже начатая часть может
продолжаться из подготовленного PWA-кеша. Ошибка exact form или asset закрывает старт до
таймера. Межвкладочная lease, owner generation, CAS revision и owner-global idempotency
не допускают второго таймера, submit или результата.

## Локальный выпускной gate

Перед заморозкой кандидата выполняются:

```text
npm test
npm run lint
npm run check
npm run openapi:grammar:check
npm run build:frontend
npm run security:secrets
npm run security:history
npm run test:e2e:ege-mock
```

`npm run test:e2e:ege-mock` включает один Chromium-контур той же попытки от настоящей
карточки на главной через все 42 позиции до результата. Он проверяет keyboard entry,
reduced motion, 44 px controls, 320 px/desktop no-overflow, offline draft, reload,
reconnect и повторную загрузку результата без дубликата. Отдельные E2E сохраняют более
глубокие проверки timer expiry, cross-tab/owner switch и provider recovery.

PostgreSQL-gate запускается только на свежем disposable instance с миграциями `001–055`,
shared file/live contract и полным cleanup. Локальный gate не даёт разрешения ни на какие
push или deploy и не разрешает production/staging изменения или платный provider run.

## Наблюдаемость

Техническая сводка доступна авторизованному администратору через
`GET /api/v1/admin/metrics`, а host-monitor — через `GET /internal/metrics` с
`MONITORING_TOKEN`. Для full mock используются HTTP requests, status distribution,
5xx rate и p95. UUID попытки в ключах маршрутов нормализуется в `:id`, поэтому новые
попытки не создают неограниченную cardinality. Контрольные маршруты:

- `/api/v1/ege-mocks/forms` — доступность выпущенной answer-free формы;
- `/api/v1/ege-mocks/attempts` и `/attempts/:id/draft` — старт и сохранение;
- `/attempts/:id/written/submit`, `/oral/start`, `/oral/stage`, `/oral/submit` — переходы;
- `/attempts/:id/result` — observational result без нового provider dispatch.

Ожидаемые lifecycle-конфликты (`EGE_MOCK_*`, `OWNER_CHANGED`,
`SUBSCRIPTION_REQUIRED`) остаются bounded API outcomes. Единственный специальный
server log для неожиданного сбоя writing dispatch содержит только timestamp, type,
bounded request/attempt id и error code. Ответ ученика, transcript и аудио никогда не
попадают в логи или метрики; payload, prompt, provider body, токены и idempotency value
также не журналируются.

Пороги и доставка алертов принадлежат общему host-monitor из `docs/MONITORING.md`.
При росте EGE 5xx оператор сначала сравнивает нормализованные route/status и health,
затем проверяет отсутствие ошибки формы/assets и доступность storage. Нельзя повторять
платную оценку для восстановления UI: result GET является observational, а recoverable
assessment использует сохранённую authority и отдельное явное действие ученика.

## Инцидент и восстановление

1. Зафиксировать время, release SHA, нормализованный route, status/error code и health;
   не копировать learner payload или provider response.
2. Если форма/assets не подтверждены, оставить fail-closed preflight: таймер ещё не
   запущен, поэтому данные попытки менять не требуется.
3. При сетевой ошибке уже начатой части сохранить offline queue. После reconnect клиент
   принимает server revision, отправляет очередь идемпотентно и не начинает новую попытку.
4. При недоступности автоматической оценки сохранить exact objective result и явный
   `pending`/`retryable` provisional state. Повтор provider work возможен только по
   существующему owner-bound recovery-контракту.
5. При rollback приложения не откатывать и не удалять миграции `053–055`, attempt rows,
   mutation ledger или результат. Сначала остановить новый rollout штатным процессом,
   затем вернуть совместимый app release и проверить read-only current/result.

Сроки и allowlisted account export описаны в `docs/DATA_RETENTION.md`, схема и lock order —
в `docs/DATABASE_SCHEMA.md`, HTTP-контракт — в `docs/openapi.yaml`. Удаление аккаунта
каскадно удаляет owner-bound attempts и mutation ledger; raw oral audio сервер приложения
не хранит. Операционная диагностика не меняет эти правила хранения.
