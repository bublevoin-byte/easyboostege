# Aisy.space learner UX: выпуск и эксплуатация

## Граница выпуска

Этот контур относится только к learner UX продукта **Aisy ЕГЭ — Английский**. Верхний уровень
содержит ровно **Сегодня → Практика → ЕГЭ → Прогресс → Профиль**; Ася открывается в контексте
текущего экрана и не является шестой вкладкой. Parent/teacher accounts, платёжный provider,
глобальное wake-word поведение и расширение банка Ticket 99 в этот выпуск не входят.

Локальный gate не даёт разрешения на push или deploy, не включает feature flags на staging или
production и не вызывает платного AI/voice provider. PostgreSQL нужен только после изменения
server/storage/schema; для UX-only кандидата используется disposable file storage. Любой новый
server/storage delta останавливает выпуск до отдельного разрешения владельца на Docker и свежий
PostgreSQL-контур.

## Выпускной gate

Кандидат фиксируется только при чистом index и одном неизменном наборе файлов. Команды выполняются
без deploy и с пустыми provider credentials:

```text
npm run lint
npm run check
npm test
npm run build:frontend
npm run test:e2e
npm run test:e2e:adaptive
npm run test:e2e:ege-mock
npm run test:e2e:aisy
npm run test:e2e:performance
npm run security:secrets
npm run security:history
git diff --check
```

`npm run test:e2e:aisy` строит frontend, запускает полный Aisy accessibility/offline contour, затем
один реальный learner Chromium-контур на локальном сервере с file-backed repository. Learner path
проходит first-start/Сегодня, Практику, ЕГЭ, точный result,
Прогресс, Профиль и Асю; проверяет настоящий router/API, reload, offline и cross-tab, обе ширины
320/1440 px, keyboard focus, screen-reader labels, reduced motion, controls не меньше 44 px и
отсутствие горизонтального overflow. Оба Aisy-контура входят последними в default `npm run test:e2e`.
Оба Aisy release child получают пустые provider credentials и fail-closed loopback endpoints; online
resource failure фиксируется по точным context-wide request/response events во всех вкладках, а
ожидаемая offline-фаза ограничена явно. Catch-all разрешает только application origin, внешние font
origins отвечает локальными пустыми stubs, а любой иной origin блокирует и фиксирует; из online API
ошибок разрешены только точные `404` first-start состояний без goal/current session. Диагностика
удаляет query values, нормализует dynamic UUID и сохраняет для любого внешнего запроса только origin;
внешний origin фиксируется даже во время deliberate offline-фазы.

EGE full-attempt gate остаётся отдельным: `npm run test:e2e:ege-mock` проводит одну server-authoritative
попытку через 42 позиции. Learner contour читает уже завершённый exact result через публичный
`/api/v1/ege-mocks/attempts/:id/result` и сверяет его с EGE hub и Progress; он не заменяет строгий
timer/state-machine тест. До этого first-start подтверждает отсутствие EGE baseline; только после
Сегодня/Практики/offline test останавливает disposable child, готовит completed fixture штатным
file repository, перезапускает тот же локальный server и продолжает browser/API путь.

## Проверяемые бюджеты

- JavaScript первой загрузки: не больше **150 КБ gzip**; измеряется до навигации и с отключённым
  service worker в `npm run test:e2e:performance`.
- LCP не больше 2,5 с, CLS не больше 0,1, INP не больше 200 мс.
- 320/375/768/1440 px, light/dark, portrait/landscape, reduced motion и offline truth проверяются
  отдельным accessibility contour; release contour повторяет критические 320/1440 seams.
- Lazy EGE/Practice/Progress/Profile/Asya не возвращаются в initial JS. Service-worker install
  closure и runtime closure остаются раздельными.

Последний подтверждённый baseline перед Ticket 09: 144,1 КБ gzip, LCP 120 мс, CLS 0,096,
INP 136 мс. Это локальная regression baseline, не production SLO; финальный кандидат обязан
получить собственный свежий замер.

## Offline, reload и cross-tab

Первая offline-навигация в уже установленной PWA может открыть закэшированный top-level hub и
обязана явно показать отсутствие сети. Offline reload не использует локальный snapshot как право
доступа: пока `/api/v1/me` нельзя проверить, shell закрывается состоянием `network-unknown` с
понятным восстановлением. После возврата сети выполняется свежая проверка доступа.

Настройки занятия и учебное evidence всегда owner-bound. Cross-tab проверка использует две вкладки
одной подтверждённой сессии, ждёт успешную запись через `/api/v1/progress/modules`, затем подтверждает
новое значение после reload первой вкладки. Ответ API другого owner, устаревшая owner generation или
непроверенная подписка не считаются восстановлением.

## Ася, privacy и безопасность

Ася работает только в открытом Aisy.space и только после намеренного действия ученика. Текстовый
keyboard path не включает микрофон и не делает provider call. До передачи аудио интерфейс отдельно
объясняет listening/transmission; diagnostic и полный ЕГЭ не получают подсказок к ответам.

Release evidence не содержит username, cookies, JWT, environment values, provider credentials,
idempotency keys, learner answers, эссе, transcript, caption, audio, request/attempt UUID или raw
provider payload. Допустимы commit SHA, команды/exit code, количество тестов, размеры сборки,
Core Web Vitals и literal bounded review outcome. `security:secrets` проверяет рабочий набор,
`security:history` — историю; ни один из них не заменяет ротацию уже раскрытого секрета.

## Инцидент и откат

1. Зафиксировать SHA, время, нормализованный route, status/error code и `/health/ready`; не копировать
   learner payload.
2. При owner/privacy/offline integrity ошибке закрыть rollout. Не удалять progress, EGE attempts,
   consent или локальные очереди вручную.
3. При performance regression сравнить свежий замер с `docs/PERFORMANCE_BASELINE.md`; бюджет 150 КБ
   не повышать и ленивые границы не исключать из теста.
4. При EGE incident использовать `docs/EGE_MOCK_OPERATIONS.md`; при adaptive incident —
   `docs/ADAPTIVE_LEARNING_OPERATIONS.md`; при voice incident — `docs/VOICE_TUTOR_OPERATIONS.md`.
5. Откатить только на совместимый app SHA штатным процессом владельца. Миграции и learner evidence
   не переписывать. Повторный rollout требует полного локального gate и нового frozen review.

## Evidence кандидата Ticket 09

Локальный кандидат собран от base `55a5093e5e4072a0878b6a2ddd3717bd73a77b73`. Product,
server, storage и schema не менялись, поэтому PostgreSQL/Docker gate не применялся. Push/deploy и
provider calls не выполнялись.

- `npm test`: 1 911 тестов, 1 863 passed, 48 skipped, 0 failed.
- `npm run lint`, `npm run check` (459 JavaScript-файлов), `npm run build:frontend` (504 assets,
  23 lazy chunks) и `npm run openapi:grammar:check`: passed.
- Default sequential `npm run test:e2e`, отдельные adaptive/EGE/Aisy gates и accessibility contour:
  passed. Release path подтвердил пять learner hubs, exact 42-position EGE result, reload,
  owner-bound cross-tab, offline close/recovery и 320/1440 px a11y без paid-provider boundary.
  Отдельный Aisy gate также passed с намеренно hostile inherited provider configuration: оба child
  сохранили fail-closed локальную границу.
- Fresh performance: initial JavaScript 144,1 КБ из 150 КБ; LCP 144 мс, CLS 0,096,
  INP 176 мс; AI-check indicator 36 мс, plan 182 мс, preview 115 мс — passed.
- Focused release/offline/security contracts, secret scan (1 265 tracked files), secret-history scan
  (323 commits) и scoped `git diff --check`: passed.

Frozen allowlist identity: `45c22175e14ce5f5e5c60b7bdf811d2872e3ea79326e67b93303c246926c067e`.
Независимые Standards и Spec review вернули literal `ZERO_FINDINGS`; локальный PRE и POST совпали.
После этого выполнен только metadata/evidence closeout Ticket 09. Этот gate по-прежнему не разрешает
deploy: для него нужен отдельный процесс владельца.
