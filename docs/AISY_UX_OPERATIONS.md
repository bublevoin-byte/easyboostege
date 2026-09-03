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

Кандидат фиксируется только при одном неизменном наборе файлов. Один обязательный локальный gate
собирает frontend ровно один раз, запускает каждую дорогую Chromium-сцену ровно один раз и не
выполняет push/deploy или платный provider call:

```text
npm run test:release:aisy
```

Команда последовательно выполняет `npm run lint`, `npm run check`, `npm test`, затем непосредственно
перед build — `npm run security:secrets` вместе с Docker-context guard, после него
`npm run build:frontend`, единый список `npm run test:e2e:aisy:built`,
`npm run test:e2e:performance`, `npm run security:history` и
`git diff --check`. В hosted CI `EASYBOOST_TEST_CONCURRENCY=1` делает unit-фазу детерминированно
последовательной для process-authority и staging fault-injection; обычный локальный `npm test` без
этой переменной остаётся параллельным. Обычные `npm run test:e2e`
и `npm run test:e2e:aisy` используют тот же список и отличаются только назначением; внутри одного
запуска тесты не дублируются.

Список проходит first-start/Сегодня, Практику, все предметные deep screens, adaptive session, ЕГЭ и
точный result, Прогресс, Профиль и Асю; проверяет настоящий router/API, reload, offline и cross-tab.
Accessibility-контур покрывает точные 320/375/768/1440 portrait/landscape × forced light/dark/system
× normal/reduced motion: canvas не шире 390 px, центрирован, bottom navigation не превращается в rail,
горизонтального overflow нет, controls не меньше 44 px. Deep Paper-тесты дополнительно проверяют
ready, empty/error/offline/blocked/review состояния, focus entry/restore, live regions, contrast и
dialog/dock containment.

Aisy release child получает пустые provider credentials и fail-closed loopback endpoints; online
resource failure фиксируется по точным context-wide request/response events во всех вкладках, а
ожидаемая offline-фаза ограничена явно. Catch-all разрешает только application origin, внешние font
origins отвечает локальными пустыми stubs, а любой иной origin блокирует и фиксирует; из online API
ошибок разрешены только точные `404` first-start состояний без goal/current session. Диагностика
удаляет query values, нормализует dynamic UUID и сохраняет для любого внешнего запроса только origin;
внешний origin фиксируется даже во время deliberate offline-фазы.

EGE full-attempt сценарии внутри единого списка проводят server-authoritative попытку через 42 позиции.
Learner contour читает уже завершённый exact result через публичный
`/api/v1/ege-mocks/attempts/:id/result` и сверяет его с EGE hub и Progress; он не заменяет строгий
timer/state-machine тест. До этого first-start подтверждает отсутствие EGE baseline; только после
Сегодня/Практики/offline test останавливает disposable child, готовит completed fixture штатным
file repository, перезапускает тот же локальный server и продолжает browser/API путь.

## Проверяемые бюджеты

- JavaScript первой загрузки: не больше **150 КБ gzip**; измеряется до навигации и с отключённым
  service worker в `npm run test:e2e:performance`.
- LCP не больше 2,5 с, CLS не больше 0,1, INP не больше 200 мс.
- 320/375/768/1440 px, forced light/dark/system, portrait/landscape, normal/reduced motion и offline
  truth проверяются отдельным accessibility contour; deep Paper-сценарии повторяют критические seams.
- Lazy EGE/Practice/Progress/Profile/Asya не возвращаются в initial JS. Service-worker install
  closure и runtime closure остаются раздельными.

Cycle 8 performance-наблюдение сохранено только в историческом `docs/PERFORMANCE_BASELINE.md`.
Текущий финальный `npm run test:release:aisy` прошёл: artifact
`d518f4a54e7b03beb357a69f7dc6380cd31befc5a11634c1ddd0df216021e290`, 26 уникальных Chromium-сценариев,
first-load JS 90.0 KB / 150 KB, LCP 108 ms, CLS 0.000, INP 64 ms; бюджеты выше от этого не меняются.

## Offline, reload и cross-tab

Первая offline-навигация в уже установленной PWA может открыть закэшированный top-level hub и
обязана явно показать отсутствие сети. Offline reload не использует локальный snapshot как право
доступа: пока `/api/v1/me` нельзя проверить, shell закрывается состоянием `network-unknown` с
понятным восстановлением. После возврата сети выполняется свежая проверка доступа.

Настройки занятия и учебное evidence всегда owner-bound. Cross-tab проверка использует две вкладки
одной подтверждённой сессии, ждёт успешную запись через `/api/v1/progress/modules`, затем подтверждает
новое значение после reload первой вкладки. Ответ API другого owner, устаревшая owner generation или
непроверенная подписка не считаются восстановлением.

При переходе с exact d367 старый document сначала показывает собственное production-уведомление
«Доступна новая версия… Обновите страницу». В нём ещё нет Ticket 11 Apply/quorum UI. Обычный online
reload через прежний network-first controller загружает candidate document, оставляя candidate worker
waiting и controller прежним; затем пользователь клавиатурой выбирает реальную кнопку
`#pwa_update_apply`. После первого consent другая exact-d367 вкладка остаётся old и может открыть
непосещённый old hashed Speaking chunk. Её online reload открывает тот же настоящий candidate UI;
реальный Apply или закрытие завершает quorum. Тест не создаёт synthetic consent control.

Quorum не определяется broad same-origin списком. Worker допускает только legacy learner-shell
`/`/`/index.html` и exact window, которое прошло `REGISTER_LEARNER_SHELL_CLIENT` handshake; так
реальные app deep links участвуют, а `/health`, `/api`, `/internal`, static assets и passive documents
не могут без учебной оболочки заблокировать consent или delayed ready-prune.

Worker делает не более 240 проверок с шагом 250 мс на один message. Ticket 11 page посылает heartbeat
через 55 секунд; если предыдущий 60-секундный цикл ещё идёт, worker ставит ровно один следующий цикл
в очередь. Так закрытие peer после исходной 60-й секунды замечается до следующего page interval,
без перекрывающихся loops или неограниченного `event.waitUntil`. Old d367 page сама heartbeat не знает,
но reloaded/consenting Ticket 11 page поддерживает эту проверку; old page без reload остаётся
nonconsenting до закрытия.

Согласие связано с exact waiting generation. Если ожидающий B уже получил consent этой вкладки, но
до quorum его заменил C, B timer/message/controller state сбрасываются, а C снова показывает enabled
«Обновить после задания» и «Позже». Ни поздний ответ B, ни старый retry не отправляют C `SKIP_WAITING`:
C остаётся waiting до нового явного нажатия видимой кнопки. Reduced motion не ослабляет это правило.

Active B во время activation фиксирует только strict immutable predecessor authority из compatibility
record: schema, full base commit, content SHA-256 и exact cache name. Durable record ограничен
schema/count/name и 1024 байтами; missing, oversized или tampered запись даёт `no prune`. Delayed
ready-prune удаляет только этот exact predecessor cache и не вызывает `caches.keys()`, поэтому уже
существующие static, EGE executable/install и client-state namespaces C, colliding prefix, foreign и
unknown caches сохраняются. EGE executable cache также release-qualified и не переиспользуется между
B/C при одинаковом path graph.

## Ася, privacy и безопасность

Ася работает только в открытом Aisy.space и только после намеренного действия ученика. Текстовый
keyboard path не включает микрофон и не делает provider call. До передачи аудио интерфейс отдельно
объясняет listening/transmission; diagnostic и полный ЕГЭ не получают подсказок к ответам.

Release evidence не содержит username, cookies, JWT, environment values, provider credentials,
idempotency keys, learner answers, эссе, transcript, caption, audio, request/attempt UUID или raw
provider payload. Допустимы commit SHA, команды/exit code, количество тестов, размеры сборки,
Core Web Vitals и literal bounded review outcome. `security:secrets` проверяет tracked files и
явный bounded inventory Ticket 11 candidate-owned untracked files из
`scripts/aisy-release-candidate-files.json`. В том же обязательном gate generic Docker-context guard
обходит каждый не исключённый recursive non-stage `COPY` input, включая gitignored файлы, и падает на
reachable пути вне этого audited объединения; исключённые protected каталоги он не обходит и не меняет.
Gate запускается после unit и непосредственно перед единственным candidate build. `security:history`
отдельно проверяет историю. Ни один scan не заменяет ротацию уже раскрытого секрета.

`.dockerignore` исключает именованные категории: `.env*` кроме безопасного `.env.example`, `.scratch`,
prototypes, QA/test и workspace debris; fail-closed гарантию даёт не denylist, а описанный pre-build
context guard. Production image собирается только через
`npm run production:image:build -- --expected-commit "$EASYBOOST_RELEASE_COMMIT"`: operator передаёт
owner-reviewed exact `EASYBOOST_NODE_BASE_IMAGE=node:22-bookworm-slim@sha256:<64hex>`, а отсутствующий
или tag-only base отклоняется до Docker. Wrapper требует exact clean Git root на полном owner-approved
commit, затем переносит ровно verified closure и control
files через два descriptor/no-follow прохода, повторно сверяет
identity/digest, сканирует все bytes и передаёт deterministic USTAR из того же Buffer прямо в stdin
`docker build`; writable temporary context у Docker отсутствует. Raw Compose build закрыт
отсутствующим sentinel; local app image имеет `pull_policy: never`, а PostgreSQL-only `up`/restore не
требуют build override.
Финальный runtime image формируется только explicit `COPY` allowlist: необходимые root runtime
files/directories, `scripts/migrate.js`, `scripts/import-json.js` и проверенный `dist/public`; broad
`COPY . .` нет.
Frontend-build stage отдельно получает полный explicit input closure, включая `public`, `shared`,
build/PWA scripts и `pwa-compat`. Synthetic context/closure regressions проверяют generic unknown paths,
Docker grammar, ordered ignore/negation, symlink escape и documented runtime entrypoint closure.

Production Compose получает PostgreSQL только через owner-approved canonical SHA256 image ID; mutable
`postgres:17-alpine` используется лишь для explicit pull/seed и не является activation authority. Fresh-host
restore вызывает общий `db:restore --database-only --confirm-restore`: remote watchdog и `PGAPPNAME` доказывают
settlement до освобождения DB lock, иначе остаётся fail-closed recovery marker.

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

## Evidence кандидата Ticket 11

Локальный кандидат начат от base `d36724181ee04230c1a9709a9213bcd269092282`; Cycle 8/10 observations
сохранены только как historical/superseded. Текущий финальный `npm run test:release:aisy`, независимые
frozen reviews и browser proof зелёные: artifact
`d518f4a54e7b03beb357a69f7dc6380cd31befc5a11634c1ddd0df216021e290`, 26 уникальных Chromium-сценариев,
first-load JS 90.0 KB / 150 KB, LCP 108 ms, CLS 0.000, INP 64 ms. Ticket 11 закрыт как локальный release
candidate. Push, deploy, staging/production mutation и live VK/provider calls не выполнялись и этим документом
не разрешаются.
