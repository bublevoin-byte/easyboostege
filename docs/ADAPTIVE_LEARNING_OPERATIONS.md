# Эксплуатация персонального плана обучения

Персональный план выпускается только через управляемый rollout. Наличие кода и успешные локальные
проверки не разрешают production-включение автоматически: push, merge, миграции и изменение
`ADAPTIVE_LEARNING_ENABLED` остаются отдельными действиями владельца.

## Перед включением

1. Зафиксировать SHA кандидата и проверить чистое рабочее дерево.
2. Выполнить `npm run lint`, `npm run check`, `npm test`, `npm run build:frontend`,
   `npm run test:e2e:adaptive` и `npm run test:e2e:performance`.
3. На отдельной PostgreSQL проверить последовательное применение миграций
   `031_adaptive_learning_goal_profile.sql`–`039_adaptive_metrics_window_indexes.sql` и repository contract.
4. Проверить owner isolation, повтор idempotency key, конкурентные start/advance/finish,
   экспорт и каскадное удаление аккаунта.
5. Убедиться, что `/internal/metrics` доступен host-monitor только с `MONITORING_TOKEN`, а
   `/api/v1/admin/metrics` — только роли `admin`.

Все E2E используют локальный файловый backend и локальный fake AI/provider. Они не совершают
production-вызовы, не подтверждают тариф провайдера и не заменяют ручной smoke после rollout.

## Rollout и откат

- По умолчанию `ADAPTIVE_LEARNING_ENABLED=false`: adaptive API не регистрируется, entry point скрыт.
- Сначала применить миграции 031–039 и проверить `/health/ready`, затем включить флаг на ограниченном
  окружении. Нельзя включать новый процесс поверх старой схемы.
- После включения проверить новым, существующим, Free, Base и Premium аккаунтами: overview,
  диагностику, preview, start, handoff, advance, finish и обновлённые profile/plan/report.
- Откат приложения: вернуть `ADAPTIVE_LEARNING_ENABLED=false` и перезапустить процесс. Это скрывает
  UI и снимает маршруты, но не удаляет данные. Миграции назад автоматически не откатывать.
- Если нарушены owner isolation, экспорт/удаление, idempotency либо evidence provenance — немедленно
  выключить флаг. При деградации completion/retention сначала остановить расширение rollout и
  исследовать агрегаты; не менять учебный профиль вручную.

## Метрики без PII

`adaptiveLearning.version=adaptive-metrics-v1` строится из одного согласованного snapshot backend.
Каждый ответ явно содержит `window={days:90,from,to}`. Счётчики сессий, completion events и диагностик
относятся только к этому скользящему 90-дневному окну; profile gauges включают только оценки, обновлённые
внутри того же окна. Поэтому старые успешные запуски не скрывают свежую регрессию.
Метрика не содержит username, user/session/attempt/skill IDs, ответов, эссе, transcript, audio,
свободного текста, credentials или idempotency values. Измерения имеют только фиксированные значения:

- `sessions`: created, started, completed; `startRate=started/created`,
  `completionRate=completed/started`; planned/completed planned minutes и их отношение;
- `sessions.byDuration`: `15_30`, `35_60`, `65_90`, `95_120`;
- `adjustments`: число/rate изменённых сессий и причины `too_difficult`, `too_easy`,
  `not_relevant`, `accessibility`, `excluded`;
- `evidence`: число learning completions по фиксированным quality/context;
- `retention`: общий, day-1 и day-7 `passed/observed/rate`; в denominator входят только
  реально наблюдавшиеся проверенные repeat outcomes;
- `diagnostics`: completed short/deep; `commercialScopes`: `free_demo`, `base`, `premium`;
- `profile`: число активных в 90-дневном окне оценок, established и high-impact/high-uncertainty
  (uncertainty ≥ 70, EGE weight ≥ 1). Это gauges, а не число уникальных учеников.

При пустом denominator rate равен `0`, а не `null` и не 100%. Для сравнения периодов внешний
сборщик должен сохранять snapshots: process HTTP counters сбрасываются при рестарте, adaptive-агрегат
каждый раз вычисляется из текущих сохранённых owner-bound записей внутри опубликованного 90-дневного окна.

Host-monitor создаёт предупреждения только после минимальной выборки:

| Сигнал | Минимальная выборка | Порог по умолчанию |
|---|---:|---:|
| start rate | 20 created | ниже 50% |
| completion rate | 10 started | ниже 50% |
| completed planned minutes | 20 created | ниже 50% |
| day-7 retention | 10 observed | ниже 50% |

Низкая выборка не считается проблемой. При алерте проверить rollout cohort, status mix,
duration buckets, commercial scope, replacement reasons и provider/HTTP health; не искать проблему
по персональным данным в метриках — их там нет.

## Offline/read-only

После успешного authenticated overview браузер хранит owner-bound публичную проекцию
`goal/profile/plan/retention/access` не более 24 часов и 120 000 символов. При временной сетевой
ошибке экран показывает этот snapshot как `offline_read_only`: forecast и allocation видны, но goal,
diagnostic, preview/create/start/replace/advance/finish недоступны. Offline-состояние никогда не
считается выполнением и не создаёт evidence.

Сохранённый cache fail-closed удаляется при неизвестной версии, повреждении, превышении размера, истечении,
будущем timestamp, owner mismatch, logout и удалении аккаунта. После восстановления сети экран
обязан перечитать authoritative overview до разрешения mutations.
Неполный ответ `PUT /goal` и новый oversized/invalid кандидат не заменяют последний безопасный полный snapshot.

## Диагностика инцидента

1. Проверить `/health/ready`, HTTP 5xx/p95 и `dependencies`.
2. Проверить версии миграций 031–039 и одинаковый результат file/PostgreSQL contract.
3. Сравнить фиксированные adaptive aggregates и alerts, не выгружая learner records.
4. Воспроизвести локально с fake provider через `npm run test:e2e:adaptive`.
5. При security/privacy/data-integrity ошибке выключить feature flag. При performance-регрессии
   сравнить с бюджетами в `docs/PERFORMANCE_BASELINE.md`.

Release evidence не должно содержать `.env`, токены, cookies, username, ответы или provider payload.
Ручное production-включение допускается только после проверки evidence владельцем.
