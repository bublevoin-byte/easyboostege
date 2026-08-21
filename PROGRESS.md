# Aisy.space — visual system v2 and Today concept

Спека: [.scratch/aisy-visual-concept/spec.md](.scratch/aisy-visual-concept/spec.md)
Тикеты: [.scratch/aisy-visual-concept/issues/](.scratch/aisy-visual-concept/issues/)
Ветка: `prototype/aisy-today-visual-v1`

Overall status: `done` — candidate design system and read-only Today prototype captured; production UI unchanged.

| № | Что даёт | Статус |
|---|---|---|
| 01 | Будущая коралловая visual system v2 и исполняемые токены | done |
| 02 | Три интерактивных Today-концепта для выбора | done |

---

# Aisy.space — learner UX redesign

Спека: [.scratch/aisy-ux-redesign/spec.md](.scratch/aisy-ux-redesign/spec.md)
Тикеты: [.scratch/aisy-ux-redesign/issues/](.scratch/aisy-ux-redesign/issues/)

Overall status: `done` — learner-first UX complete; parent/teacher roles remain separate future releases.

| № | Что даёт | Статус |
|---|---|---|
| 01 | Бренд Aisy.space и общий design foundation | done |
| 02 | Оболочка ученика: Сегодня / Практика / ЕГЭ / Прогресс / Профиль | done |
| 03 | Персональный экран Сегодня и диагностический маршрут | done |
| 04 | Practice hub поверх существующих учебных модулей | done |
| 05 | Отдельный EGE hub поверх строгого пробника | done |
| 06 | Честные Progress/Profile и только Free/Premium в public copy | done |
| 07 | Контекстная Ася и честные microphone/wake states | done |
| 08 | Accessibility/offline/themes и initial JS <=150 KB gzip | done |
| 09 | Сквозной learner release contour и ZERO×2 review | done |

Принятые продуктовые решения: платформа `Aisy.space` («Эйси»), продукт `Aisy ЕГЭ — Английский`,
ассистент `Ася`; ученик 10–11 класса занимается преимущественно с телефона 20–40 минут. Архитектура
резервирует learner/parent/teacher, но текущий выпуск реализует только learner. Public plans — Free и
Premium; внутренний Base может сохраниться только как compatibility detail. Wake name работает лишь в
явно открытой microphone session приложения, а не глобально как системный ассистент.

---

# Прогресс — активное изучение слов

Спека: [.scratch/active-vocabulary-system/spec.md](.scratch/active-vocabulary-system/spec.md)
Тикеты: [.scratch/active-vocabulary-system/issues/](.scratch/active-vocabulary-system/issues/)
Ветка: `feature/adaptive-learning-plan`

| № | Что даёт | Статус |
|---|---|---|
| 01 | Освоение слова и мягкая миграция | done |
| 02 | Библиотека, темы и подробная карточка | done |
| 03 | Умная тренировка активного вспоминания | done |
| 04 | Личные слова из чтения без противоречий | done |
| 05 | Результаты слов в индивидуальном плане | done |
| 06 | Мобильная проверка и выпускной контур | done |

---

## Полный пробный ЕГЭ-2026

Спека: `.scratch/ege-full-mock-2026/spec.md`

Overall status: `done` — Tickets 01–07 complete; Ticket 99 remains `needs-triage` after release hardening.

Ticket 07 pre-freeze evidence: настоящая home card уже открывает `scr16`, placeholder отсутствует. Публичный
release-contract RED `0/2` зафиксировал два оставшихся разрыва: общий gate не включал один сквозной Chromium
контур той же попытки, а EGE-specific operator contract отсутствовал. GREEN `2/2` добавляет
`e2e/ege-mock-release.test.js` в оба EGE/default gate и `docs/EGE_MOCK_OPERATIONS.md` с exact
`ege-en-2026-form-1@1`, server timers `190 + 17`, PWA/offline/reconnect, normalized `:id` monitoring,
privacy, incident/rollback, retention и локальной release boundary.

Новый E2E начинает diagnostic с home card клавишей Enter, посещает позиции `1–38`, сохраняет offline draft через
reload/reconnect и проводит все `26` oral-команд и `11` response stages позиций `39–42` через настоящий
browser -> `/oral/stage` -> domain -> file-storage контур с тестовым composition clock. При чередовании
`320/1440 px` он проверяет reduced motion, screen-reader timer/status и controls `>=44 px`, делает реальный oral
submit/result, перезагружает тот же `42`-item baseline и подтверждает, что history по-прежнему содержит ровно одну
строку этой попытки. Узкий EGE-набор written/oral/result/release и полный последовательный Chromium зелёные;
adaptive Chromium также зелёный.

Первый строгий frozen review обнаружил заменённую in-memory oral machine/direct repository finalization,
недостаточную проверку post-reload history, возможный дочерний процесс при readiness failure и устаревшие статусы
Tickets 05/06 в нижней таблице. Публичный real-route RED получил `409 EGE_MOCK_ORAL_STAGE_TOO_EARLY`; минимальный
test-only server clock seam дал GREEN без изменения production clock, fake oral machine и прямой repository
finalization удалены, readiness failure теперь останавливает созданный процесс, post-reload history проверяется как
`length === 1`, а Tickets 05/06 отмечены `done`. Ticket 99 не менялся.

Следующий frozen Spec review вернул literal `ZERO_FINDINGS`, а Standards обнаружил implementation-coupled
`onclick` source assertion вместо публичного seam, недостижимую диагностическую ветку из-за двойного submit wait и
мёртвые import/clock state. Source assertion удалён: home card/Enter остаётся проверен только через настоящий
Chromium UI; единственный guarded wait теперь сохраняет diagnostic, а stale scaffolding удалён. Повторные release
contract `2/2` и real home-to-result Chromium зелёные.

Полный unit: `1863 total / 1815 pass / 48` ожидаемых PostgreSQL skips / `0 fail` в `38826.3768 ms`.
`lint`, generated/executable OpenAPI, `check` (`428` JavaScript files / `211` handlers / `126` names), build
(`485` assets / `649.3 KB` unpacked shell JavaScript / `12` lazy chunks), secrets (`1216` tracked files), history
(`314` commits) и `git diff --check` зелёные. Performance operational metrics зелёные: LCP `296 ms`, CLS `0`, INP
`96 ms`, AI indicator `38 ms`, adaptive overview `112 ms`, preview `39 ms`; известный унаследованный first-load
JavaScript остаётся `182.9 KB > 150 KB`, EGE screen/form/result при этом сохраняют lazy boundary.

Fresh post-remediation PostgreSQL project `easyboost-postgres-integration-33300` применил миграции `001–055` и
прошёл literal `48/48`, `0 fail` в `14650.6133 ms`. Compose удалил container, volume и network; точные
project-label фильтры `com.docker.compose.project=easyboost-postgres-integration-33300` пусты для всех трёх
ресурсов. Docker остановлен владельцем, pipe/backend/Desktop отсутствуют. Provider/paid call, install, push,
deploy и production audit не выполнялись; dependency declarations и lockfile не менялись. Ticket 99 остаётся явным обязательным
напоминанием после Ticket 07: существенно расширить проверенный авторский банк и формы.

Финальный strict freeze на exact ordered allowlist из `8` файлов имел `540523` raw bytes и SHA-256
`454aa6a18a69c136c1214386470c6a5a8d3510069dd0ff8e8602475f7b28860a`; HEAD/base оставался
`190a06fa7cc65b6457708b505316537a167f6a98`, index был пуст. Два brand-new read-only review независимо вернули
literal `ZERO_FINDINGS` для Standards и Spec при совпавших PRE=POST identity. Ticket 07 закрыт metadata-only;
push/deploy отсутствуют, Ticket 99 сохранён как обязательный post-release reminder.

Ticket 06 pre-freeze evidence: после обеих частей один server-authoritative domain-модуль выдаёт canonical
42-позиционный безопасный результат с breakdown `12/12/18/20/20` и максимумом `82`. Один shared contract владеет
section/item maxima, лимитом истории, weak-skill mapping и отдельной явной 83-строчной таблицей versioned
`ege-mock-forecast-2026-v1`. Exact objective и experimental/approximate subjective компоненты различены;
частичная проверенная subjective evidence входит в честную нижнюю границу, missing/technical остаётся `null`, а
training repeat вообще не пересчитывает собственный прогноз. Развёрнутый learner text и устные записи не входят в
result; safe rubric, feedback и bounded evidence доступны только для проверенных развёрнутых ответов.

Первый diagnostic закреплён как immutable baseline. Каждый повтор создаёт новый UUID и сохраняет исходные
form/revision/fingerprint с mode `training`; bounded selector удерживает baseline и текущую активную попытку только
для reconciliation/storage policy, а публичная история показывает terminal attempts плюс immutable baseline и не
выдаёт незавершённую попытку за исторический результат. Diagnostic-only проекция добавляет ровно одну assisted
adaptive/error-bank запись на
фактический weak skill, использует существующие Grammar/Speaking/Vocabulary/Listening/Reading/Writing маршруты,
идемпотентна при reload/history и не даёт mastery credit или частотного умножения. Owner-bound/offline dashboard
показывает сохранённый diagnostic baseline, а не новый training forecast.

Первый независимый Standards/Spec review обнаружил расхождения OAS maxima, unbounded history, дублированную
policy, потерю partial subjective evidence, независимый training forecast, неполный safe review и отсутствующие
dashboard/error-bank projections. Все пункты закрыты отдельными публичными RED→GREEN регрессиями. Следующий
frozen Standards/Spec review нашёл два reachable сценария: deadline reconciliation мог сохранить terminal
diagnostic без derived error focus, а higher cross-tab assessment revision не инвалидировал уже показанные
result/history. Публичные RED подтвердили оба разрыва. Повторный strict freeze review затем зафиксировал deferred
final-oral settlement при отклонённой команде и первое in-flight result чтение без attempt identity; публичные RED
воспроизвели и эти два сценария. File/PostgreSQL теперь проводят каждую reconciliation через один result/error-focus
persistence seam, включая rejected late mutation и rejected settlement в final-stage grace; UI до первого ответа
связывает загрузку с attempt, хранит требуемую assessment revision и ставит один authoritative follow-up, поэтому
старый GET не может установить устаревшие result/history. Shared contract проверяет file и live PostgreSQL parity.

Последний frozen Standards/Spec review нашёл ещё два P1: blank внутри composite objective answer обходил normalizer
и обнулял earned band, а независимые result/history GET могли установить разные assessment snapshots без локальной
cross-tab invalidation. Публичный RED дал ровно два ожидаемых отказа. Shared assessment normalizer теперь считает
каждый предоставленный subanswer и сохраняет незаполненность для UI, а browser принимает пару result/history только
при полном совпадении canonical current-attempt snapshot и автоматически перечитывает смешанную пару. Следующий
Standards review (при literal `ZERO_FINDINGS` от Spec) обнаружил, что PostgreSQL `Date` сортировался как locale
string и мог вытеснить newest attempt из saturated history. Точный RED `0/1` закрыт одним chronological
milliseconds/ISO comparator для newest, baseline, storage selection и diagnostic evidence. Focused GREEN `28/28`,
relevant result/API/storage/adaptive/UI/catalog `136/136` и полный unit `1851 total / 1803 pass / 48` ожидаемых
PostgreSQL skips / `0 fail` в `33404.4685 ms` зелёные. Lint,
generated/executable OpenAPI, check (`426` JS / `211` handlers / `126` names), build (`485` assets / `648.1 KB`
shell JS / `12` lazy chunks), свежие полный последовательный Chromium, узкий result E2E и adaptive Chromium также
зелёные. Повторные secrets (`1208` tracked files) и history (`313` commits) прошли. Свежие performance operational
metrics: LCP `308 ms`, CLS `0`, INP `96 ms`, AI `38 ms`, overview `105 ms`, preview `37 ms`; единственный известный
выход — унаследованный first-load JavaScript `182.3 KB > 150 KB`, при этом EGE result остаётся lazy.

Fresh authorized disposable PostgreSQL project `easyboost-postgres-integration-28908` применил миграции `001–055`
и прошёл literal `48/48` в `15388.5529 ms`, включая rejected deadline/final-stage reconciliation,
result/history/adaptive/error-bank, owner lock, export/delete и file/PostgreSQL parity. Compose удалил container,
volume и network; независимые точные project-label фильтры пусты.
Координатор остановил Docker и подтвердил отсутствие pipe. Provider/paid call, install, push и deploy не
выполнялись. Dependency declarations и lockfile не менялись, поэтому ранее разрешённый production audit `0
vulnerabilities` остаётся применимым без нового registry-запроса. Ticket 99 остаётся явным напоминанием существенно
расширить проверенный авторский банк.

Свежий frozen Standards/Spec review обнаружил три последние reachable границы. History/dashboard GET сам не
reconciled истёкшую `oral_in_progress`, поэтому terminal diagnostic мог отсутствовать до отдельного attempt GET;
частично заполненный composite exact answer получал честный band, но UI не называл пропуск явно; same-tab settlement
во время уже идущей загрузки результата отбрасывался ранним `finalResultLoading` и оставлял старой согласованной
паре право на commit. Публичные RED зафиксировали missing load-claim export `0/1` и history-only baseline `0/1`.
File/PostgreSQL history теперь под owner lock сначала reconciles активную попытку и только затем строит bounded
terminal history; UI объявляет «Ответ заполнен частично» и каждый пустой слот; единый public load-claim инвалидирует
in-flight tuple и ставит authoritative follow-up с требуемой assessment revision. GREEN: result/UI `22/22`, shared
file lifecycle `1/1`, scoped result/API/storage/adaptive/UI `130/130`; полный unit `1853 total / 1805 pass / 48`
ожидаемых PostgreSQL skips / `0 fail` в `32690.1849 ms`. Lint, generated/executable OpenAPI, check (`426` JS / `211`
handlers / `126` names), build (`485` assets / `648.1 KB` shell JS / `12` lazy chunks), узкий result E2E, полный
последовательный и adaptive Chromium зелёные. Performance operational metrics: LCP `320 ms`, CLS `0`, INP `104 ms`,
AI `39 ms`, overview `114 ms`, preview `40 ms`; единственный известный выход остаётся унаследованным first-load
JavaScript `182.3 KB > 150 KB`, при этом EGE result lazy. Secrets (`1208` tracked files) и history (`313` commits)
прошли. Fresh authorized PostgreSQL project `easyboost-postgres-integration-22092` применил `001–055` и прошёл
`48/48` в `14309.5312 ms`; container/volume/network cleanup `0/0/0`, как и pre-start project `26556`. Docker
остановлен. Provider/paid call, install, push, deploy и production audit не выполнялись; dependency graph не
менялся.

Следующий frozen review нашёл один общий blank-semantics P2 и один safe-review P2: валидные whitespace-only
scalar/composite ответы обходили явные blank/partial labels, а завершённые Speaking 39–42 показывали внутренний
`criteriaRef` вместо понятного rubric. RED focused `20/24` дал ровно четыре ожидаемых отказа. Один trimmed blank seam
теперь одинаково форматирует scalar, all-empty и partial composite; shared result contract связывает каждый
immutable speaking criteriaRef с bounded human-readable aggregate rubric/next step, server canonical result публикует
честные `got/max`, UI скрывает внутренний ID, а executable OAS разрешает один aggregate speaking criterion, сохраняя
writing minimum `3/5`. Focused GREEN `24/24`, scoped result/API/storage/adaptive/UI `132/132`; полный unit `1855 total
/ 1807 pass / 48` ожидаемых PostgreSQL skips / `0 fail` в `32086.2575 ms`. Lint, generated/executable OpenAPI, check
(`426` JS / `211` handlers / `126` names), build (`485` assets / `648.1 KB` shell JS / `12` lazy chunks), узкий result
E2E, полный последовательный и adaptive Chromium зелёные. Performance operational metrics: LCP `96 ms`, CLS
`0.018`, INP `104 ms`, AI `40 ms`, overview `108 ms`, preview `33 ms`; только унаследованный first-load `182.3 KB >
150 KB` остаётся известным выходом. Secrets `1208` / history `313` зелёные. Fresh PostgreSQL project
`easyboost-postgres-integration-27300` применил `001–055` и прошёл `48/48` в `14337.3423 ms`; cleanup
container/volume/network `0/0/0`, Docker остановлен. Provider/paid call, install, push, deploy и production audit не
выполнялись; dependency graph не менялся. Ticket 06 остаётся `in-progress` до строгого hardcoded raw-byte freeze,
двух свежих независимых literal `ZERO_FINDINGS`, metadata closeout и единственного локального коммита координатора.

Следующий frozen Standards/Spec review обнаружил две согласованные release-границы: старый terminal training result
вне bounded `20` history запускал бесконечный строгий tuple reload, а executable export OAS всё ещё обещал отсутствие
answer key при допустимом раскрытом `correctAnswer` завершённого EGE. RED дал четыре ожидаемых focused отказа.
Optional owner-bound `attemptId` теперь удерживает exact terminal attempt вместе с immutable baseline и newest rows,
не расширяя history сверх `20`; file/PostgreSQL делят canonical builder, route валидирует UUID, browser сохраняет
fail-closed mixed-snapshot проверку, а export OAS точно описывает раскрытие только после обеих частей. GREEN:
focused `39/39`, scoped result/API/storage/adaptive/UI `132/132`; полный unit `1855 total / 1807 pass / 48`
ожидаемых PostgreSQL skips / `0 fail` в `31992.7555 ms`; lint, generated/executable OpenAPI, check (`426` JS / `211`
handlers / `126` names), build (`485` assets / `648.1 KB` shell JS / `12` lazy chunks), узкий result E2E, полный
последовательный и adaptive Chromium зелёные. Performance: LCP `296 ms`, CLS `0`, INP `96 ms`, AI `41 ms`, overview
`93 ms`, preview `39 ms`; единственный унаследованный выход — first-load `182.3 KB > 150 KB`. Secrets `1208` /
history `313` зелёные. Fresh PostgreSQL project `easyboost-postgres-integration-12332` применил `001–055`, прошёл
`48/48` в `13385.6038 ms`, удалил container/volume/network (`0/0/0`); Docker остановлен. Provider/paid call, install,
push, deploy и production audit не выполнялись; dependency graph не менялся. Ticket 06 остаётся `in-progress` до
нового strict hardcoded raw-byte freeze, двух свежих literal `ZERO_FINDINGS`, metadata closeout и одного локального
коммита координатора.

Следующий frozen review обнаружил два executable OAS P2: history-only `attemptId` был ошибочно объявлен также на
answer-free forms GET, а scored Speaking 39–42 мог пройти canonical schema без human-readable `criteria` и safe
`feedback`. Focused RED `20/22` дал ровно два ожидаемых отказа. Forms теперь имеет только фактический owner contract;
canonical item различает positions 1–38, pending Speaking и scored Speaking, причём scored branch требует минимум
один bounded criterion и feedback. Shared executable evaluator и negative regressions закрепляют ту же корреляцию.
GREEN: focused `22/22`, scoped result/API/storage/adaptive/UI `132/132`; полный unit `1855 total / 1807 pass / 48`
ожидаемых PostgreSQL skips / `0 fail` в `32781.5556 ms`; lint, generated/executable OpenAPI, check (`426` JS / `211`
handlers / `126` names), build (`485` assets / `648.1 KB` shell JS / `12` lazy chunks) зелёные. Remediation изменила
только OAS и executable tests/evaluator, поэтому свежие PostgreSQL `48/48`, narrow/full/adaptive Chromium,
performance и security evidence предыдущего checkpoint остаются точными. Provider/paid call, install, push, deploy
и production audit не выполнялись; dependency graph не менялся. Ticket 06 остаётся `in-progress` до нового strict
hardcoded raw-byte freeze, двух свежих literal `ZERO_FINDINGS`, metadata closeout и одного локального коммита.

Standards следующего frozen review вернул literal `ZERO_FINDINGS`, но Spec обнаружил status/score P2: canonical
Speaking item принимал `completed + null` и non-completed numeric score. RED result/UI `23/25` дал два ожидаемых
отказа. OAS, browser validator и shared executable evaluator теперь разрешают точные runtime ветви
`not_started|pending|retryable + null` (реальный safe pre-assessment state) либо
`completed + numeric score + criteria + feedback`; остальные сочетания fail closed. GREEN: focused API/result/UI
`36/36`, scoped result/API/storage/adaptive/UI `133/133`; полный unit `1856 total / 1808 pass / 48` ожидаемых
PostgreSQL skips / `0 fail` в `31695.3769 ms`; lint, generated/executable OpenAPI, check (`426` JS / `211` handlers /
`126` names), build (`485` assets / `648.1 KB` shell JS / `12` lazy chunks) и свежий узкий result Chromium зелёные.
Server/storage не менялись, поэтому fresh PostgreSQL `48/48` и full/adaptive Chromium, performance/security evidence
предыдущих checkpoint остаются точными. Provider/paid call, install, push, deploy и production audit не выполнялись;
dependency graph не менялся. Ticket 06 остаётся `in-progress` до нового strict hardcoded raw-byte freeze, двух
brand-new literal `ZERO_FINDINGS`, metadata closeout и одного локального коммита.

Standards следующего frozen review снова вернул literal `ZERO_FINDINGS`, но Spec обнаружил симметричный
status/score P2 для Writing 37–38: canonical item принимал `completed + null` и non-completed numeric score. RED
result/UI `24/26` дал ровно два ожидаемых отказа. OAS, browser validator и shared executable evaluator теперь
разрешают точные runtime ветви `not_started|pending|retryable|ambiguous + null` либо
`completed + numeric score + минимум три criteria + feedback + evidence`; остальные сочетания fail closed. GREEN:
focused API/result/UI `37/37`, scoped result/API/storage/adaptive/UI `134/134`; полный unit `1857 total / 1809 pass /
48` ожидаемых PostgreSQL skips / `0 fail` в `33585.6791 ms`; lint, generated/executable OpenAPI, check (`426`
JavaScript files / `211` handlers / `126` names), build (`485` assets / `648.1 KB` shell JavaScript / `12` lazy
chunks) и свежий узкий result Chromium зелёные. Remediation изменила только OAS, browser validator и executable
tests/evaluator, поэтому fresh PostgreSQL `48/48`, full/adaptive Chromium, performance/security evidence предыдущего
checkpoint остаются точными. Provider/paid call, install, push, deploy и production audit не выполнялись; dependency
graph не менялся. Ticket 06 остаётся `in-progress` до нового strict hardcoded raw-byte freeze, двух brand-new literal
`ZERO_FINDINGS`, metadata closeout и одного локального коммита.

Standards следующего frozen review вернул literal `ZERO_FINDINGS`, но Spec обнаружил dashboard identity P2:
executable OAS и online progress допускали baseline object с `null`/чужим pointer либо нулём отображённых попыток,
хотя runtime и offline cache строили точную immutable diagnostic baseline. RED `38/41` дал ровно три ожидаемых
отказа. Один экспортируемый browser-safe sanitizer теперь одинаково защищает online/offline: отсутствие baseline
требует `baselineAttemptId:null + displayedAttempts:0`, а видимая baseline — matching UUID и окно `1..20`. OAS
закрепляет те же discriminated branches и exact-ID extension/evaluator. GREEN: focused `41/41`, scoped
result/API/storage/adaptive/UI `136/136`; полный unit `1859 total / 1811 pass / 48` ожидаемых PostgreSQL skips / `0
fail`. Lint, generated/executable OpenAPI, check (`426` JavaScript files / `211` handlers / `126` names), build
(`485` assets / `648.0 KB` shell JavaScript / `12` lazy chunks) и свежий adaptive Chromium зелёные. Remediation не
затронула server/storage, поэтому fresh PostgreSQL `48/48`, result/full Chromium и performance/security evidence
предыдущих checkpoint остаются точными. Provider/paid call, install, push, deploy и production audit не
выполнялись; dependency graph не менялся. Ticket 06 остаётся `in-progress` до нового strict hardcoded raw-byte
freeze, двух brand-new literal `ZERO_FINDINGS`, metadata closeout и одного локального коммита.

Spec следующего frozen review вернул literal `ZERO_FINDINGS`, но Standards обнаружил оставшийся executable OAS
range-order P2: custom dashboard evaluator связывал baseline identity/count, но принимал перевёрнутые primary и
forecast `minimum/maximum`, которые shared online/offline sanitizer уже отклонял. RED result `11/12` дал ровно
один ожидаемый отказ; две negative regression-пары теперь исполняемо требуют `minimum <= maximum` для обоих
диапазонов. GREEN: focused `12/12`, scoped result/API/storage/adaptive/UI `136/136`; полный unit остаётся `1859
total / 1811 pass / 48` ожидаемых PostgreSQL skips / `0 fail`. Lint, generated/executable OpenAPI и check (`426`
JavaScript files / `211` handlers / `126` names) зелёные. Remediation изменила только executable evaluator и test,
поэтому свежие build (`485` assets / `648.0 KB` / `12` lazy chunks), adaptive/result/full Chromium, PostgreSQL
`48/48`, performance и security evidence предыдущих checkpoint остаются точными. Provider/paid call, install, push,
deploy и production audit не выполнялись; dependency graph не менялся. Ticket 06 остаётся `in-progress` до нового
strict hardcoded raw-byte freeze, двух brand-new literal `ZERO_FINDINGS`, metadata closeout и одного локального
коммита.

Standards следующего frozen review вернул literal `ZERO_FINDINGS`, но Spec обнаружил два parity P2. Dashboard
boundary связывал identity/count/order, но не `primaryTotal`, primary range, forecast score/range и versioned
conversion policy. Available result одновременно мог принять canonical pending и completed composite/top-level
assessment, из-за чего UI controls расходились с отображёнными баллами. Exact RED `47/51` дал четыре ожидаемых
отказа. Один versioned forecast predicate теперь владеет dashboard correlation в eager metadata, а два shared result
predicate связывают canonical Writing/Speaking с composite и top-level controls; online/offline sanitizer, browser
renderer и executable OAS evaluator используют эти seams. GREEN: focused `51/51`, scoped
result/API/storage/adaptive/UI `137/137`. Первый full gate дополнительно дал точный offline-closure RED: eager cache
не должен был притянуть lazy EGE result contract в APP_SHELL. Conversion table/predicate перенесены без дублирования
в уже eager forecast metadata, lazy EGE closure сохранена; итоговый полный unit `1860 total / 1812 pass / 48`
ожидаемых PostgreSQL skips / `0 fail`. Lint, generated/executable OpenAPI, check (`426` JavaScript files / `211`
handlers / `126` names), build (`485` assets / `649.2 KB` shell JavaScript / `12` lazy chunks), свежие result и
adaptive Chromium зелёные. Performance operational metrics: LCP `296 ms`, CLS `0`, INP `96 ms`, AI `52 ms`,
overview `98 ms`, preview `34 ms`; единственный известный выход остаётся унаследованным first-load JavaScript
`182.6 KB > 150 KB`. Remediation не затронула server/storage, поэтому fresh PostgreSQL `48/48`, full Chromium и
security evidence предыдущих checkpoint остаются точными. Provider/paid call, install, push, deploy и production
audit не выполнялись; dependency graph не менялся. Ticket 06 остаётся `in-progress` до нового strict hardcoded
raw-byte freeze, двух brand-new literal `ZERO_FINDINGS`, metadata closeout и одного локального коммита.

Следующий frozen Standards/Spec review обнаружил две executable correlation P2. Completed Writing/Speaking
projection мог сохранить canonical item scores, но подменить aggregate `score`; same-status top-level controls
одновременно не были связаны с exact Writing `assessmentRevision` и полным набором Speaking item assessments.
RED `27 total / 25 pass / 2 fail` дал ровно ожидаемые отказы. Один shared browser-safe predicate теперь требует
для completed projection точный distinct position set и aggregate score canonical section; available-result
predicate связывает top-level Writing revision и все общие Speaking controls/items с nested composite. Browser и
executable OAS используют тот же seam. GREEN: focused `27/27`, scoped result/API/storage/adaptive/UI `137/137`;
полный unit `1860 total / 1812 pass / 48` ожидаемых PostgreSQL skips / `0 fail` в `39955.7513 ms`. Lint,
generated/executable OpenAPI, check (`426` JavaScript files / `211` handlers / `126` names), build (`485` assets /
`649.2 KB` shell JavaScript / `12` lazy chunks) и свежий узкий result Chromium зелёные. Диагностический recursive
all-files запуск отдельно переобнаружил три unrelated E2E flakes, выключенный Docker для PostgreSQL runner и
известный first-load budget `182.6 KB > 150 KB`; isolated applicable gates зелёные. Shared contract не затронул
server/storage, поэтому fresh PostgreSQL `48/48`, adaptive/full Chromium и security evidence предыдущего checkpoint
остаются точными. Provider/paid call, install, push, deploy и production audit не выполнялись; dependency graph не
менялся. Ticket 06 остаётся `in-progress` до нового strict hardcoded raw-byte freeze, двух brand-new literal
`ZERO_FINDINGS`, metadata closeout и одного локального коммита.

Следующий frozen Standards/Spec review выявил четыре correlation-границы. Pending dashboard принимал zero-width
exact range при `primaryTotal:null`; composite Writing мог расходиться с canonical safe review; top-level Speaking
item — с nested `errorCode`; общий assessment retry summary — с фактическими Writing controls. RED `39 total / 36
pass / 3 fail` дал ровно три ожидаемых failing test block, причём OAS-block содержал также обе retry-проверки после
первого отказа. Shared dashboard predicate теперь требует non-degenerate pending range; result contract использует
semantic JSON equality для Writing criteria/feedback/evidence, сравнивает Speaking `errorCode` и связывает aggregate
`retryAllowed/retryCount` с Writing assessment. GREEN: focused `39/39`, scoped result/API/storage/adaptive/UI
`137/137`; полный unit `1860 total / 1812 pass / 48` ожидаемых PostgreSQL skips / `0 fail` в `33710.2048 ms`. Lint,
generated/executable OpenAPI, check (`426` JavaScript files / `211` handlers / `126` names), build (`485` assets /
`649.3 KB` shell JavaScript / `12` lazy chunks) и свежий узкий result Chromium зелёные. Shared predicates не
затронули server/storage, поэтому fresh PostgreSQL `48/48`, adaptive/full Chromium, performance и security evidence
предыдущих checkpoint остаются точными. Provider/paid call, install, push, deploy и production audit не выполнялись;
dependency graph не менялся. Ticket 06 остаётся `in-progress` до нового strict hardcoded raw-byte freeze, двух
brand-new literal `ZERO_FINDINGS`, metadata closeout и одного локального коммита.

Следующий frozen review обнаружил две status/projection P2: objective section принимал pending status рядом с
полностью completed exact items, а незавершённая Writing projection могла выкинуть уже проверенное canonical
задание или продублировать одну позицию. RED `28 total / 25 pass / 3 fail` воспроизвёл browser status, executable
OAS status и partial Writing omission. Один shared canonical predicate теперь связывает status каждой section с
полным набором unscored items и требует completed, когда все scored; browser и custom OAS evaluator используют его
без второй логики. Composite predicate для любого status требует distinct projection positions и присутствие
каждого canonical completed/scored item. GREEN: focused `39/39`, scoped result/API/storage/adaptive/UI `137/137`;
полный unit `1860 total / 1812 pass / 48` ожидаемых PostgreSQL skips / `0 fail` в `34638.3018 ms`. Lint,
generated/executable OpenAPI, check (`426` JavaScript files / `211` handlers / `126` names), build (`485` assets /
`649.3 KB` shell JavaScript / `12` lazy chunks) и свежий узкий result Chromium зелёные. Shared/UI validation не
затронула server/storage; fresh PostgreSQL `48/48`, adaptive/full Chromium, performance/security evidence предыдущих
checkpoint остаются точными. Provider/paid call, install, push, deploy и production audit не выполнялись; dependency
graph не менялся. Ticket 06 остаётся `in-progress` до нового strict hardcoded raw-byte freeze, двух brand-new literal
`ZERO_FINDINGS`, metadata closeout и одного локального коммита.

Spec следующего frozen review вернул literal `ZERO_FINDINGS`, но Standards обнаружил race P2 в первом adaptive
overview после oral deadline: history reconciliation и evidence snapshot запускались параллельно, поэтому ответ мог
уже показать terminal diagnostic baseline, но ещё старый profile без его weak-skill evidence. Публичный RED adaptive
`31 total / 30 pass / 1 fail` точно воспроизвёл неверный порядок. Overview теперь сначала завершает owner-bound
history reconciliation, а затем читает один evidence snapshot; file и PostgreSQL adapters используют одинаковый
маршрутный seam. GREEN: adaptive `31/31`, scoped result/API/storage/adaptive/UI `138/138`; полный unit `1861 total /
1813 pass / 48` ожидаемых PostgreSQL skips / `0 fail` в `33788.9575 ms`. Lint, generated/executable OpenAPI, check
(`426` JavaScript files / `211` inline handlers / `126` names), build (`485` assets / `649.3 KB` shell JavaScript /
`12` lazy chunks), свежие adaptive и узкий result Chromium зелёные. Fresh PostgreSQL project
`easyboost-postgres-integration-16372` применил migrations `001–055`, прошёл `48/48` в `13056.863 ms` и удалил
container/volume/network (`0/0/0`); Docker остановлен. Performance/security evidence предыдущего checkpoint остаётся
точным; provider/paid call, install, push, deploy и production audit не выполнялись, dependency graph не менялся.
Ticket 06 остаётся `in-progress` до нового strict hardcoded raw-byte freeze, двух brand-new literal
`ZERO_FINDINGS`, metadata closeout и одного локального коммита.

Следующий frozen review обнаружил два parity P2. Goal-save follow-up overview обновлял profile/cache, но не
перерисовывал вновь reconciled immutable diagnostic baseline; executable OAS evaluator одновременно не связывал
canonical `responseState` с exact/subjective item kind. Публичный RED `28 total / 26 pass / 2 fail` точно
воспроизвёл оба разрыва. Goal-save refresh теперь рисует EGE dashboard до сохранения того же snapshot в cache, а
один shared browser-safe predicate разрешает только `provided|blank` для positions 1–36 и
`submitted_hidden|technical|blank` для positions 37–42; browser и executable OAS используют один seam. GREEN:
focused `28/28`, scoped result/API/storage/adaptive/UI `138/138`; полный unit `1861 total / 1813 pass / 48`
ожидаемых PostgreSQL skips / `0 fail` в `35163.9645 ms`. Lint, generated/executable OpenAPI, check (`426` JavaScript
files / `211` inline handlers / `126` names), build (`485` assets / `649.3 KB` shell JavaScript / `12` lazy chunks),
свежие adaptive и узкий result Chromium зелёные. Этот раунд не менял server/storage, поэтому свежий PostgreSQL
`48/48` из project `easyboost-postgres-integration-16372`, performance и security evidence предыдущего checkpoint
остаются точными; Docker остановлен. Provider/paid call, install, push, deploy и production audit не выполнялись,
dependency graph не менялся. Ticket 06 остаётся `in-progress` до нового strict hardcoded raw-byte freeze, двух
brand-new literal `ZERO_FINDINGS`, metadata closeout и одного локального коммита.

Финальный strict exact35 freeze имел raw-byte identity
`429b686ce7face894eb46bdfac3b4e6c2fb38f9044afbea5432d7948cc773df0` при неизменном base/HEAD
`41bcfe6bb683a12526fe4563f91dca3c16d46619` и пустом index. Два brand-new read-only review независимо вернули
literal `ZERO_FINDINGS` для Standards и Spec с совпавшими PRE=POST identity. Ticket 06 закрыт metadata-only change;
единственный локальный commit создаётся сразу после exact allowlist staging, без push/deploy/provider/install.
Ticket 07 и reminder Ticket 99 сохранены нетронутыми.

Ticket 05 pre-freeze evidence: exact owner/attempt/form/task/stage-bound oral tasks 39–42 run under a separate
server-authoritative 17-minute timer after mic and immutable-asset preflight. The device-local WAV/IndexedDB layer,
durable idempotent UUIDv4 start/stage/submit commands, offline reload/reconnect, immutable 11-response cursor,
responsive keyboard/reduced-motion UI and explicit-only provisional assessment reuse existing full Speaking,
pronunciation and evaluation modules through `selection_reason = ege_mock`; safe GET performs no provider work.
Missing or technical evidence stays retryable/null, tasks 39–42 expose maxima `1/4/5/10` with the canonical
`experimental` / `approximate` warning, and all EGE speaking evidence is assisted so it cannot grant mastery credit.

Six frozen-review/remediation rounds drove public-seam TDD across authoritative server time, GET bridge
reconciliation, exact-final-deadline settlement, cross-tab identity, technical/skipped evidence, immutable asset
TOCTOU, PostgreSQL lock order, paid-result settlement ambiguity, EGE score/mode honesty, oral a11y, duplicated
contract ownership, distinct stage UUIDs, ordered offline journals, reload capture and canonical deadline evidence.
One shared oral contract owns all `17`-minute/task/count/timing/maximum constants. A paid provider result whose
durable finish cannot be confirmed retains its pending claim, returns
`SPEAKING_EVALUATION_SETTLEMENT_UNKNOWN` and never falls through to another provider. A transient false-online
browser signal now preserves the exact queued oral projection on explicit `NETWORK_ERROR` without observational GET
or command loss, while authoritative conflicts still reconcile normally.

The fifth review added durable cross-tab oral serialization and rollback, monotonic-only advancement after a server
clock sample, real-time `TOO_EARLY` journal retention, stale-recorder cancellation/rebinding, canonical technical
codes, PostgreSQL EGE assistance provenance, legacy-shadow lifecycle guards, terminal speaking retry honesty and
owner→EGE→Speaking subscription-checked provider claim/settlement. Public RED groups were `29/24/5`, `20/17/3`,
`17/15/2`, post-submit claim `21/20/1`, PG lock order `3/2/1`, and the browser later exposed one late written refresh
overwriting the oral timer (`11/10/1`). All are GREEN; the final oral/UI contour is `31/31` and fresh full Chromium
is green.

The fourth public-seam RED was `47 total / 41 pass / 6 intended fail`: candidate-authored historical time,
cross-attempt local restore, final offline stage-plus-submit recovery, UI attempt binding and executable EGE OAS
semantics all failed first. GREEN is `47/47`: server stage mutations use only repository time; local envelopes are
exact-attempt-bound and mismatch-purged; the durable journal restores and replays final stage then submit; OpenAPI
discriminates ordinary `automatic_training` from EGE `experimental` and preserves EGE technical needs-retry/null.

Fresh disposable PostgreSQL project `easyboost-postgres-integration-30492` applied migrations `001–055` and passed
all `48/48` registered tests in `12771.6974 ms`; Compose removed container/volume/network and exact project-label
filters are empty. Docker 28.0.1 is stopped with its daemon pipe absent. Pre-documentation gates are green: full unit
`1808 total / 1760 pass / 48` expected PostgreSQL skips / `0 fail` in `31976.457 ms`; lint; executable/generated
OpenAPI; check (`422` JS / `211` handlers / `126` names); build (`485` assets / `645.6 KB` shell JS / `12` lazy
chunks); dedicated EGE, fresh full and adaptive Chromium; secrets (`1193` tracked files); history (`312` commits);
diff-check; and fresh authorized production audit (`0 vulnerabilities`). Performance operational metrics pass at LCP
`300 ms`, CLS `0`, INP `96 ms`, AI loading `40 ms`, adaptive overview `89 ms` and preview `32 ms`; only the
documented base first-load budget remains `181.5 KB > 150 KB` (Ticket04 baseline `180.7 KB`), while EGE remains
lazy. No provider/paid call, install, push, deploy or Ticket 06 occurred. Ticket 05 remains `in-progress` pending
post-documentation gates, strict hardcoded-allowlist freeze, fresh literal `ZERO_FINDINGS`×2 and metadata closeout;
the sole local commit is held for the coordinator. Ticket 99 remains the explicit reminder to expand the verified
authored bank substantially.

Ticket 05 final post-documentation gates preserve full unit `1808 total / 1760 pass / 48` expected PostgreSQL skips /
`0 fail` in `32646.1498 ms`; lint, executable/generated OpenAPI, check (`422` JS / `211` handlers / `126` names),
diff-check, secrets `1193`, history `312`, build (`485` assets / `645.6 KB` shell JS / `12` lazy chunks), dedicated
EGE, fresh full and adaptive Chromium are green. The last browser RED `0/1` prevents a same-cursor journal write
from repeatedly cancelling a live recording while preserving cancel-before-adopt for a real remote cursor change.
Performance operational metrics pass at LCP `372 ms`, CLS `0`, INP `112 ms`, AI loading `45 ms`, adaptive overview
`107 ms` and preview `41 ms`; the inherited first-load baseline alone remains `181.5 KB > 150 KB`. Fresh live
PostgreSQL migrations `001–055`, `48/48`, cleanup-empty evidence and authorized production audit `0 vulnerabilities`
remain exact. Docker remains stopped with pipe absent; Ticket 99 remains intact. The scoped candidate is ready for a
strict hardcoded raw-byte freeze and two fresh literal `ZERO_FINDINGS` reviews.

The sixth frozen review found seven final browser/contract seams: cross-tab observational GET/write feedback,
competing microphone capture, an offline navigation resetting the monotonic epoch, missing EGE
`methodicallyValidated:false`, a per-second live-region announcement, the task-42 composite constrained to half a
mobile grid, and an oral E2E that stopped at task 39 preparation. Public RED was oral runner/media/UI `42 total / 37
pass / 5 intended fail` plus executable assessment-contract `0/1`; GREEN is `42/42`, `1/1`, and the combined focused
contour `65/65`. A non-writing `refreshLocal` projection, one held owner/attempt recorder Web Lock, cross-navigation
`performance.timeOrigin + performance.now()` authority, the shared canonical speaking warning contract, quiet stage
text and a full-width verified composite close those seams. The expanded Chromium path completes all exact `11`
responses across tasks `39–42`, reload/offline/reconnect, one cross-tab recorder owner with bounded GETs, 320/1440
layouts and 44 px controls, submit, exactly `11` explicit WAV uploads and four approximate evaluations; safe restore,
GET and reconnect still perform zero provider work.

Latest non-PostgreSQL gates are full unit `1813 total / 1765 pass / 48` expected skips / `0 fail` in `37472.5589 ms`;
lint; executable/generated OpenAPI; check (`422` JS / `211` handlers / `126` names); build (`485` assets / `645.6 KB`
shell JS / `12` lazy chunks); dedicated EGE, full and adaptive Chromium; secrets `1193`; history `312`; and
allowlist-scoped diff-check. Performance remains operationally green at LCP `300 ms`, CLS `0`, INP `96 ms`, AI
loading `42 ms`, adaptive overview `95 ms` and preview `34 ms`; the inherited first-load budget alone remains `181.6
KB > 150 KB`. The final remediation changed no persistence or migrations, so the fresh disposable PostgreSQL
`001–055`, `48/48`, cleanup-empty evidence remains exact; Docker is stopped. Authorized production audit remains `0`
because manifests did not change. No provider/paid call, install, push, deploy or Ticket 06 occurred. Ticket 99's
verified-bank expansion reminder remains intact. Ticket 05 stays `in-progress` until a new strict allowlist freeze,
fresh literal `ZERO_FINDINGS`×2, metadata closeout and the coordinator-held local commit.

The fourth final frozen review found six reachable release seams: stale asynchronous oral initialization, durable
`prepared` without current device assets, account deletion between WAV persistence and journal commit, a closed tab
stuck beyond a per-response deadline, automatic paid JSON repair for malformed EGE output, and broad oral-recording
OAS status invariants. Public RED was oral/domain/UI `47 total / 43 pass / 4 intended fail`, paid-call `0/1`, and OAS
`0/1`; focused GREEN is `102/102`. Oral readiness now always repeats preflight after reload, initialization and late
recording completion are epoch/owner/attempt bound, every journal commit is owner-incarnation guarded with exact WAV
rollback, and server reads deterministically settle missed stages as `response_timeout` after a shared five-second
grace. EGE malformed output receives no automatic second paid call, and OAS binds every status/digest/duration/code
and position/task/response maximum.

Fresh non-PostgreSQL gates are full unit `1818 total / 1770 pass / 48` expected PostgreSQL skips / `0 fail` in
`34721.7847 ms`; lint; executable/generated OpenAPI; check (`422` JS / `211` handlers / `126` names); build (`485`
assets / `645.6 KB` shell JS / `12` lazy chunks); dedicated EGE, full and adaptive Chromium; secrets `1193`; history
`312`; and diff-check. Performance operational gates pass at LCP `312 ms`, CLS `0`, INP `96 ms`, AI `39 ms`, overview
`101 ms` and preview `37 ms`; only inherited first-load `181.6 KB > 150 KB` remains. Live PostgreSQL first exposed
clock-parity RED `47/48`; after the named-attempt GET shared the injected contract clock, fresh disposable project
`easyboost-postgres-integration-32420` applied migrations `001–055` and passed literal `48/48` in `13414.0556 ms`.
Cleanup and exact project-label filters for pre-escalation `25548`, RED `34240` and GREEN `32420` are empty; Docker is
stopped with pipe absent. No provider/paid call, install, push, deploy or Ticket 06 occurred. Ticket 99's verified-bank
expansion reminder remains intact; Ticket 05 remains `in-progress` pending final post-doc gates and fresh literal
`ZERO_FINDINGS`×2.

Final post-documentation verification preserves full unit `1818 total / 1770 pass / 48` expected PostgreSQL skips /
`0 fail` in `34683.5678 ms`; lint, executable/generated OpenAPI, check (`422` JS / `211` handlers / `126` names),
build (`485` assets / `645.6 KB` shell JS / `12` lazy chunks), secrets `1193`, history `312`, diff-check, fresh full and
adaptive Chromium are green. Performance operational metrics pass at LCP `332 ms`, CLS `0`, INP `104 ms`, AI `48
ms`, overview `99 ms` and preview `38 ms`; the inherited first-load `181.6 KB > 150 KB` is the only performance
exit. Fresh PostgreSQL migrations `001–055`, literal `48/48` and cleanup-empty evidence remain exact; Docker is
stopped. Next is the strict hardcoded allowlist freeze and two fresh independent literal `ZERO_FINDINGS` reviews.

The fifth-final frozen review exposed five last cross-layer contracts: provider authorization could outlive the
route subscription/voice-consent snapshot, an EGE bridge resync could switch the accent pinned to an existing full
Speaking projection, an immutable stage replay could regress the live oral cursor and strand a second WAV, safe GET
wording denied its deterministic deadline reconciliation, and OpenAPI admitted impossible oral cursor/ledger
combinations. Exact grouped RED was full unit `1822 total / 1768 pass / 48` expected PostgreSQL skips / `6 fail`,
followed by one executable OAS RED for a future ledger key. Owner-serialized provider claims now recheck current
Base plus version-bound voice consent only before new/recovered paid work; non-paying frozen replay remains safe.
The first bridge accent pin is immutable, immutable command replay adopts a fresh authoritative attempt and retires
only an unbound exact WAV, while generated OAS encodes all eleven exact oral states and ledger prefixes.

Focused GREEN is `6/6`, expanded oral/EGE/Speaking/HTTP is `106/106`, lock/offline is `66/66`, and full unit is
`1822 total / 1774 pass / 48` expected PostgreSQL skips / `0 fail` in `34746.758 ms`. Lint, executable/generated
OpenAPI, check (`422` JS), build (`485` assets / `12` lazy chunks), dedicated EGE, full and adaptive Chromium,
secrets `1193`, history `312` and diff-check are green. Performance passes LCP `316 ms`, CLS `0`, INP `104 ms`, AI
`54 ms`, overview `100 ms` and preview `36 ms`; the inherited first-load JS baseline alone remains `181.5 KB > 150
KB`. The sandbox-denied project `easyboost-postgres-integration-9360` left only an isolated disposable volume,
which exact scoped cleanup removed. Authorized project `easyboost-postgres-integration-30608` applied migrations
`001–055` and passed literal `48/48` in `13638.3602 ms`; exact project-label filters are empty for both identities.
Docker is stopped with pipe absent. No provider/paid call, install, push, deploy or Ticket 06 occurred; unchanged
manifests preserve audit `0 vulnerabilities`, and Ticket 99's verified-bank expansion reminder remains intact.
Ticket 05 stays `in-progress` pending post-documentation gates, a new strict complete allowlist freeze and fresh
literal `ZERO_FINDINGS`×2; the sole commit remains held for the coordinator.

Post-documentation gates are full unit `1822 total / 1774 pass / 48` expected PostgreSQL skips / `0 fail` in
`35079.8717 ms`; lint; executable/generated OpenAPI; check (`422` JS / `211` handlers / `126` names); build (`485`
assets / `645.6 KB` shell JS / `12` lazy chunks); dedicated EGE, full and adaptive Chromium; secrets `1193`;
history `312`; and diff-check. Performance operational metrics pass at LCP `300 ms`, CLS `0`, INP `96 ms`, AI
`50 ms`, overview `107 ms` and preview `41 ms`; only the inherited initial-JS baseline remains `181.5 KB > 150
KB`. The scoped candidate is ready for a new strict complete allowlist freeze and fresh literal
`ZERO_FINDINGS`×2; metadata closeout and the sole local commit remain held.

The sixth-final Ticket 05 remediation closed post-lock claim time, frozen paid-result recovery, terminal local-audio
cleanup and exact API/OAS state correlation. The first grouped RED was `121` total / `68` pass / `48` expected
PostgreSQL skips / `5` fail; after a test-only runner fixture correction, the exact journal seam was RED `26/25/1`,
and a later executable OAS seam was RED `0/1` for completed-attempt/pending-speaking drift. File and PostgreSQL now
sample authorization time after their owner serialization boundary. Exact already-settled semantic and full
pronunciation requests replay without renewed subscription/consent and without provider work; anything new or
recoverable still requires current Base and version-bound voice consent. Terminal reconciliation removes every
queued WAV not present in the authoritative ledger, runtime rejects impossible task/response/duration tuples at
validation, and executable OpenAPI correlates speaking item/status/score, attempt lifecycle and available results.
Focused GREEN is `142` total / `94` pass / `48` expected PostgreSQL skips / `0` fail. Full unit is `1823 total /
1775 pass / 48` expected PostgreSQL skips / `0 fail` in `36102.6334 ms`; lint, generated/executable OpenAPI, check
(`422` JS / `211` handlers / `126` names), build (`485` assets / `645.6 KB` / `12` lazy), dedicated EGE, full
sequential and adaptive Chromium, secrets `1193`, history `312`, diff-check and fresh authorized production audit
(`0 vulnerabilities`) are green. Performance is LCP `316 ms`, CLS `0`, INP `96 ms`, AI `44 ms`, overview `100 ms`
and preview `40 ms`; only inherited first-load JS `181.5 KB > 150 KB` remains. Disposable PostgreSQL project
`easyboost-postgres-integration-24028` applied migrations `001–055`, passed `48/48` in `13548.6759 ms`, removed its
container/volume/network and left all exact-label filters empty. Docker is stopped with pipe absent. Ticket 05 is
still `in-progress` until post-doc gates, a strict complete allowlist freeze, fresh literal `ZERO_FINDINGS`×2,
metadata closeout and the sole local commit. No provider/paid call, install, push, deploy or Ticket 06 occurred;
Ticket 99 remains the explicit reminder to expand the verified authored bank substantially.

The final Ticket 05 post-documentation rerun is full unit `1823 total / 1775 pass / 48` expected PostgreSQL skips /
`0 fail` in `34909.5975 ms`; lint; generated/executable OpenAPI; check (`422` JS / `211` handlers / `126` names);
build (`485` assets / `645.6 KB` shell JS / `12` lazy chunks); dedicated EGE, full sequential and adaptive
Chromium; secrets `1193`; history `312`; and diff-check. Performance operational metrics pass at LCP `320 ms`,
CLS `0`, INP `104 ms`, AI `51 ms`, overview `117 ms` and preview `40 ms`; only the inherited first-load JavaScript
baseline remains `181.5 KB > 150 KB`. Docker and provider processes remain stopped. The candidate proceeds to a
strict complete raw-byte allowlist freeze and fresh literal `ZERO_FINDINGS`×2; metadata closeout and the sole local
commit remain held.

Ticket 05 final closeout supersedes its historical checkpoints above. Fresh independent final7 Standards and Spec
reviews both returned literal `ZERO_FINDINGS` on the identical frozen `59`-path candidate. Each reproduced
PRE=POST with `59` unique paths, `0` missing, `4,436,814` raw bytes and SHA-256
`d3bf82bddcd00a7288167eab8ea8865b1e13884c8d0d01bd8a462299aef07679`; HEAD/base/merge-base were all
`cf6b15cc725ed4d580d5bba1aa0d96feedd7b9b4` and the candidate index was empty. Ticket 05 is `done`; Ticket 06 is
next and remains untouched. The sole local Ticket05 commit is coordinator-held. No provider/paid call, install,
push or deploy occurred, Docker is stopped, and Ticket 99 remains the explicit reminder to expand the verified
authored bank substantially.

Ticket 04 final closeout supersedes its historical checkpoints below. Brand-new final17 Standards and Spec reviews
both returned literal `ZERO_FINDINGS` on identical frozen 65-path identity
`94fe023854b78f69e6657ea1461acfb6f5555da25518a3a998026cbf3c4153d8`, with PRE=POST at
HEAD/base/merge-base `bd201588fc539454c9dfe94e684947b3b546ea4f`, candidate index `0`, `46` tracked changes plus
`19` intended untracked paths and zero missing paths. Final gates are full unit `1750 total / 1703 pass / 47`
expected PostgreSQL skips / `0 fail`; fresh PostgreSQL migrations `001–054` and `47/47`; lint; both OpenAPI checks;
check (`411` JS / `211` handlers / `126` names); build (`484` assets / `644.4 KB` shell JS / `11` lazy chunks);
dedicated/full/adaptive Chromium; secrets `1174`; history `311`; and allowlist-only diff-check. Docker is stopped
with pipe absent. Ticket 04 is `done`; Ticket 05 remains next/ready only and was not started. The sole local Ticket04
commit includes this metadata closeout; no provider/paid call, install, push or deploy occurred. Ticket 99 remains
the explicit reminder to expand the verified authored bank substantially.

Ticket 04 thirtieth frozen-review remediation closes the same final16 claim-classification finding independently
reported by Standards and Spec on exact 65-path identity
`faf6125c2c8e5144a55c00e614fff234bc7d8dfa61db75d461a1b6d90e055096`. Exact public RED was `2 total / 0 pass /
2 fail`: authoritative pre-provider `AI_BUDGET_EXHAUSTED` and `RATE_LIMITED` both became false
`provider_result_recovery_pending` states. The current reservation is now removed only for those exact proven
unspent outcomes. Duplicate/uncertain acknowledgement and any earlier paid reservation keep the same stable token;
deterministic quota/rate refusal discards its unspent token and preserves the ordinary retryable reason. GREEN is
combined `3/3`, service `14/14`, expanded AI/EGE `231/231`, and full unit `1750 total / 1703 pass / 47` expected
PostgreSQL skips / `0 fail`.

Lint, both generated OpenAPI checks, check (`411` JS / `211` handlers / `126` names), allowlist-only diff-check,
build (`484` assets / `644.4 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium, secrets `1174` and
history `311` are green. Fresh disposable PostgreSQL project `easyboost-postgres-integration-30476` applied
migrations `001–054` and passed `47/47`; compose cleanup and exact container/volume/network label filters are empty.
Docker is stopped with pipe absent. Exclusions, the transparent name-only audit-enumeration note, no provider/paid
call/install/push/deploy/Ticket 05, and Ticket 99's verified-bank expansion reminder remain in force. Ticket 04 stays
`in-progress` pending post-doc gates, strict freeze, literal ZERO×2, metadata closeout and its sole local commit.

Thirtieth-remediation post-doc verification preserves full unit `1750 total / 1703 pass / 47` expected skips / `0
fail` in `28291.2415 ms`; lint, both generated OpenAPI checks, check (`411` JS / `211` handlers / `126` names),
allowlist-only diff-check, build (`484` assets / `644.4 KB` shell JS / `11` lazy chunks), secrets `1174` and history
`311` remain green. The last delta is evidence-only, so dedicated/full/adaptive Chromium and fresh PostgreSQL
`47/47` remain applicable. Docker is stopped with pipe absent. Next is the strict hardcoded-allowlist freeze and two
fresh literal `ZERO_FINDINGS` reviews.

Ticket 04 twenty-ninth frozen-review remediation follows a final15 Spec literal `ZERO_FINDINGS` and one Standards
provider-recovery finding on exact 65-path identity
`dbb3d6f979f25d2484d430f816b2e28048f81213be808f3379874b4cda59abca`. Exact public RED was `1 total / 0 pass / 1
fail`: an already-durable AI-operation claim still produced retryable state with `discardPreparedOutcome: true`.
Metered reservation is now counted before the durable claim acknowledgement, so duplicate/uncertain acknowledgement
preserves the stable prepared token as `prepared_unknown`, returns `provider_result_recovery_pending`, performs zero
evaluator work and cannot invite a new UUID/provider call. GREEN is targeted `1/1`, service `12/12`, expanded AI/EGE
`218/218`, and full unit `1748 total / 1701 pass / 47` expected PostgreSQL skips / `0 fail`.

Lint, both generated OpenAPI checks, check (`411` JS / `211` handlers / `126` names), diff-check, build (`484`
assets / `644.4 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium, secrets `1174` and history `311`
are green. Fresh disposable PostgreSQL project `easyboost-postgres-integration-31456` applied migrations `001–054`
and passed `47/47`; compose cleanup completed and exact container/volume/network label filters are empty. Docker is
stopped with pipe absent. The denied pre-daemon project `easyboost-postgres-integration-7996` created nothing.
Exclusions, the transparent name-only audit-enumeration note, no provider/paid call/install/push/deploy/Ticket 05,
and the Ticket 99 verified-bank expansion reminder remain in force. Ticket 04 stays `in-progress` pending post-doc
gates, a strict hardcoded-allowlist freeze, literal ZERO×2, metadata closeout and its sole local commit.

Twenty-ninth-remediation post-doc verification preserves full unit `1748 total / 1701 pass / 47` expected skips /
`0 fail` in `28568.9711 ms`; lint, both generated OpenAPI checks, check (`411` JS / `211` handlers / `126` names),
allowlist-only diff-check, build (`484` assets / `644.4 KB` shell JS / `11` lazy chunks), secrets `1174` and history
`311` remain green. The last delta is evidence-only, so dedicated/full/adaptive Chromium and fresh PostgreSQL
`47/47` remain applicable. Docker is stopped with pipe absent. Next is the strict hardcoded-allowlist freeze and two
fresh literal `ZERO_FINDINGS` reviews.

Ticket 04 twenty-eighth frozen-review remediation follows a final14 Spec literal `ZERO_FINDINGS` and one Standards
exhaustion race on exact 65-path identity
`59147f4ab79a7850a8c4547976ecfca7f98d87f00b0f569e5b8ec1142ce56c3a`. Exact public RED was `1 total / 0 pass /
1 fail`: current MAX+pending, finite legacy marker+pending and cross-tab sentinel+later command all reported blocked
and queued while sending one POST. Normalization and merge now atomically advance the command watermark and clear
the command when exhaustion wins; restore persists legacy cleanup, and flush has an independent post-merge guard.
All three scenarios are blocked/not queued/zero POST in GREEN `1/1`; runner is `76/76`, expanded EGE `143/143`, and
full unit `1747 total / 1700 pass / 47` expected PostgreSQL skips / `0 fail`.

Lint, both generated OpenAPI checks, check (`411` JS / `211` handlers / `126` names), diff-check, build (`484`
assets / `644.4 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium, secrets `1174` and history `311`
are green. The browser-only change leaves fresh PostgreSQL project `easyboost-postgres-integration-7180` migrations
`001–054`, `47/47` and cleanup-empty evidence applicable; Docker is stopped with pipe absent. Exclusions, no
provider/paid call/install/push/deploy/Ticket 05 and the Ticket 99 bank reminder remain unchanged. Ticket 04 stays
`in-progress` pending post-doc gates, a fresh hardcoded-allowlist freeze, literal ZERO×2, metadata closeout and its
sole local commit.

Twenty-eighth-remediation post-doc verification preserves full unit `1747 total / 1700 pass / 47` expected skips /
`0 fail` in `28498.3008 ms`; lint, both generated OpenAPI checks, check (`411` JS / `211` handlers / `126` names),
diff-check, build (`484` assets / `644.4 KB` shell JS / `11` lazy chunks), secrets `1174` and history `311` remain
green. Dedicated/full/adaptive Chromium already cover the final browser runtime; the last delta is evidence-only,
and fresh PostgreSQL `47/47` remains applicable. Next is the strict allowlist freeze and fresh literal ZERO×2.

Ticket 04 twenty-seventh frozen-review remediation follows a final13 Standards literal `ZERO_FINDINGS` and one Spec
stale-device exhaustion finding on exact 65-path identity
`1bbcfaa68c20e847982b12973c50a2991e41b52de2d5eb25e753e5634b70708a`. Exact browser-runner RED was `1 total / 0
pass / 1 fail`: revision-4 exhaustion followed by server-MAX restore emitted both the original UUID `…022` and a
new UUID `…023`. A durable per-attempt MAX sentinel plus one shared predicate now blocks snapshot, automatic,
retry, renewal and cross-tab merge paths before and after reconciliation; legacy revision markers promote to the
sentinel on restore. GREEN is targeted `1/1`, runner `75/75`, expanded EGE `142/142` and full unit `1746 total /
1699 pass / 47` expected PostgreSQL skips / `0 fail`.

Lint, both generated OpenAPI checks, check (`411` JS / `211` handlers / `126` names), diff-check, build (`484`
assets / `644.4 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium, secrets `1174` and history `311`
are green. Browser-only durable state leaves fresh PostgreSQL project `easyboost-postgres-integration-7180`
migrations `001–054`, `47/47` and cleanup-empty evidence applicable; Docker is stopped with pipe absent. Exclusions,
no provider/paid call/install/push/deploy/Ticket 05, and the Ticket 99 bank-expansion reminder remain unchanged.
Ticket 04 stays `in-progress` pending post-doc gates, a fresh hardcoded-allowlist freeze, literal ZERO×2, metadata
closeout and its sole local commit.

Twenty-seventh-remediation post-doc verification preserves full unit `1746 total / 1699 pass / 47` expected skips
/ `0 fail` in `28533.1711 ms`; lint, both generated OpenAPI checks, check (`411` JS / `211` handlers / `126` names),
diff-check, build (`484` assets / `644.4 KB` shell JS / `11` lazy chunks), secrets `1174` and history `311` remain
green. Dedicated/full/adaptive Chromium already cover the final browser runtime; the last delta is evidence-only and
fresh PostgreSQL `47/47` remains applicable. Next is the strict allowlist freeze and fresh literal ZERO×2.

Ticket 04 twenty-sixth frozen-review remediation follows a final12 Standards literal `ZERO_FINDINGS` and one Spec
OpenAPI precision finding on exact 65-path identity
`5c340530e1df6a6ce715172ea8585b2abb2734495f809b47a7a025409f0f95ad`. Runtime already emits the nested
`writingAssessment.runDisposition` and top-level `assessmentRunDisposition` subscription block together or neither;
the executable schema now does the same across explicit available/unavailable × blocked/unblocked variants. Exact
public RED was `10 total / 9 pass / 1 fail`, focused GREEN is `10/10`, and expanded EGE GREEN is `142/142` with both
mismatch directions rejected in both availability branches. Standalone full unit is `1746 total / 1699 pass / 47`
expected PostgreSQL skips / `0 fail`; lint, both generated OpenAPI checks, check (`411` JS / `211` handlers / `126`
names) and diff-check are green.

Only the API description and public executable-schema test changed, so prior dedicated/full/adaptive Chromium and
fresh PostgreSQL project `easyboost-postgres-integration-7180` migrations `001–054`, `47/47`, cleanup-empty evidence
remain applicable. Docker is stopped with pipe absent. Exclusions, no provider/paid call/install/push/deploy/Ticket
05 and the Ticket 99 verified-bank expansion reminder remain unchanged. Ticket 04 stays `in-progress` pending
post-doc gates, a new hardcoded-allowlist freeze, fresh literal ZERO×2, metadata closeout and its sole local commit.

Twenty-sixth-remediation post-doc verification preserves full unit `1746 total / 1699 pass / 47` expected skips /
`0 fail` in `28457.7551 ms`; lint, both generated OpenAPI checks, check (`411` JS / `211` handlers / `126` names),
diff-check, build (`484` assets / `644.4 KB` shell JS / `11` lazy chunks), secrets `1174` and history `311` are
green. The last delta is description/test/evidence only, so dedicated/full/adaptive Chromium and fresh PostgreSQL
`47/47` remain applicable. Next is the strict hardcoded-allowlist freeze and fresh literal ZERO×2.

Ticket 04 twenty-fifth frozen-review remediation closes all three final11 findings. Exact public RED was `94 total /
91 pass / 3 fail`; focused GREEN is `94/94`, focused plus direct discriminated-state coverage is `99/99`, and the
expanded EGE contour is `134/134`. One neutral browser/server validator now owns the exact writing-assessment DTO
discriminant and rejects malformed restore/HTTP projections before merge or UUID retirement. A recognized durable
assessment command must have an exact v4 UUID, non-negative safe order, mandatory acknowledgement flag,
action-specific shape and strict after-watermark order; malformed present state fails closed without minting or
transport. An existing pending UUID can finalize/replay an already-durable `subscription_required` MAX snapshot
without provider work, assessment mutation or another ledger row.

Pre-documentation gates are green: full unit `1746 total / 1699 pass / 47` expected PostgreSQL skips / `0 fail`;
lint; generated OpenAPI; check (`411` JS / `211` handlers / `126` names); diff-check; build (`484` assets / `644.4
KB` shell JS / `11` lazy chunks); dedicated/full/adaptive Chromium; secrets `1174`; history `311`. Unchanged
manifests preserve the authorized audit at exact `0 vulnerabilities`. The denied pre-daemon project
`easyboost-postgres-integration-24712` created nothing; disposable project `easyboost-postgres-integration-7180`
applied migrations `001–054` and passed `47/47`, then removed its container, volume and network. Exact label filters
for both identities are empty; Docker 28.0.1 is stopped with pipe absent.

One accidental status command printed names only from the excluded product-readiness tree; no excluded content was
opened, read, searched, edited or staged, the command was not repeated, and freeze/review identity remains a strict
Ticket04 allowlist excluding that tree and the ignored FIPI context. No provider/paid call, install, push, deploy or
Ticket 05 occurred; Ticket 99 retains the verified-bank expansion reminder. Ticket 04 stays `in-progress` pending
post-doc gates, a new raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local commit.

Twenty-fifth-remediation post-doc verification makes the subscription-expiry HTTP fixture derive its clock from the
repository-issued `sub_until + 1 second`, eliminating calendar drift without production behavior change. EGE API is
`10/10`, affected is `134/134`, and the standalone full rerun is `1746 total / 1699 pass / 47` expected skips / `0
fail`. Serial build remains `484` assets / `644.4 KB` shell JS / `11` lazy chunks; all other non-PG gates remain
green, while dedicated/full/adaptive Chromium and fresh PostgreSQL `47/47` stay applicable to the test/doc-only
delta. Docker is stopped with pipe absent. Next is the hardcoded-allowlist freeze and fresh literal ZERO×2.

Ticket 04 twenty-fourth frozen-review remediation closes the final10 Standards P3 and two brand-new Spec findings.
One shared DOM/Node-independent semantic-JSON module replaces the duplicated recursive implementations. Terminal
server-answer authority is no longer folded into the bounded local event clock, descending UUIDs cannot erase the
automatic run after retry acknowledgement, server revisions compare numerically across `9→10` and `99→100`, and an
older immutable response cannot atomically replace the newer attempt draft/lifecycle. Exact public RED was `74 total /
71 pass / 3 fail`; focused GREEN is `74/74`, expanded affected GREEN is `99/99`.

The first full-unit pass exposed two unrelated concurrent old HTTP `401` transients; that contour passed isolated
`23/23`, then the immediate standalone full rerun passed `1743 total / 1696 pass / 47` expected PostgreSQL skips / `0
fail`. Lint, generated OpenAPI, check (`411` JS / `211` handlers / `126` names), diff-check, build (`484` assets /
`643.0 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium, secrets `1174` and history `311` are green.
Unchanged manifests preserve the authorized production audit at exact `0 vulnerabilities`. This remediation changes
browser ordering and extracts a behavior-preserving shared helper only; migration/storage/PostgreSQL behavior is
unchanged, so live project `easyboost-postgres-integration-14332` migrations `001–054` and `47/47` remains applicable.
Docker is stopped with pipe absent. No provider/paid call, install, push, deploy or Ticket 05 occurred; audit/FIPI
exclusions and the Ticket 99 bank-expansion reminder remain intact. Ticket 04 stays `in-progress` pending post-doc
gates, a new raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local commit.

Ticket 04 twenty-third frozen-review remediation follows a literal `ZERO_FINDINGS` Standards pass and two Spec P2
hypotheses. The first now has an explicit public regression that delivers a stale immutable POST response after a
newer exact GET advanced lifecycle revision/state/draft and assessment revision; it passed before production edits
and proves the current runner keeps the whole newer attempt while validating and retiring the old UUID. The second
was real: MAX_SAFE preflight prevented an existing pending UUID from freezing an assessment that had already
terminalized. Exact RED was `90 total / 89 pass / 1 fail`; focused GREEN is `90/90`, and affected GREEN is `158 total
/ 111 pass / 47` expected PostgreSQL skips / `0 fail`.

One shared domain predicate lets only an existing pending UUID with an already-terminal writing assessment reach
mutation-free settlement at revision `9007199254740991`. Its existing ledger row freezes the exact terminal attempt
and exact replay is provider-free; no second row is created. New and nonterminal UUIDs still fail MAX_SAFE preflight
under the owner/attempt lock before ledger, claim, disposition or provider work. Full unit remains `1740 total / 1693
pass / 47` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`410` JS / `211` handlers / `126`
names), diff-check, build (`484` assets / `643.0 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium,
secrets `1174` and history `311` are green. Unchanged manifests preserve the authorized production audit at exact `0
vulnerabilities`.

Fresh disposable PostgreSQL project `easyboost-postgres-integration-14332` applied migrations `001–054` and passed
exact `47/47` in `11995.4865 ms`, including terminal pending-UUID settlement/replay at MAX and all prior persistence,
export and deletion parity. Compose cleanup completed; exact container/volume/network label filters are empty; Docker
28.0.1 is stopped with pipe absent. No provider/paid call, install, push, deploy or Ticket 05 occurred; audit/FIPI
exclusions and the Ticket 99 bank-expansion reminder remain intact. Ticket 04 stays `in-progress` pending post-doc
gates, a new raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local commit.

Ticket 04 twenty-third-remediation post-documentation verification preserves focused `90/90`, affected `158 total
/ 111 pass / 47` expected PostgreSQL skips / `0 fail`, and full unit `1740 total / 1693 pass / 47` expected skips /
`0 fail`. Lint, generated OpenAPI, check (`410` JS / `211` handlers / `126` names), diff-check, build (`484` assets /
`643.0 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets `1174` and history `311` are
green. The authorized production audit remains exact `0 vulnerabilities` with unchanged manifests; fresh live
PostgreSQL remains exact `47/47`. Docker is stopped with pipe absent. The next boundary is the exclusion-safe
raw-byte freeze and two brand-new literal `ZERO_FINDINGS` reviews.

Ticket 04 twenty-second frozen-review remediation closes four final public-contract gaps. Public TDD recorded exact
RED `90 total / 86 pass / 4 fail`, plus a dedicated browser revision-exhaustion RED `1 total / 0 pass / 1 fail`, and
focused GREEN `102/102`. Cross-tab assessment merge now normalizes and compares a detached clone, so a higher
`assessmentRevision` wins atomically and equal-revision semantic drift cannot mutate focused memory, storage or its
logical clock. Persisted commands accept only the known action enum, with migration limited to the bounded legacy
missing-action `assessmentRetry` shape. Terminal command responses use first `applied:true/replayed:false` and exact
replay `applied:true/replayed:true`; `false/true` is invalid, and UUID retirement follows full-envelope validation.

File and PostgreSQL perform the MAX_SAFE preflight under the owner/attempt lock before ledger begin/claim: revision
`9007199254740990` may advance once, while a new run at `9007199254740991` deterministically returns non-retryable
`ASSESSMENT_REVISION_EXHAUSTED` with zero ledger, provider or state mutation. The browser durably retires/blocks that
UUID and executable OpenAPI fixes the same maximum and replay-flag contract. Pre-documentation gates are green:
focused `102/102`; full unit `1740 total / 1693 pass / 47` expected PostgreSQL skips / `0 fail`; lint; generated
OpenAPI; check (`410` JS / `211` handlers / `126` names); diff-check; build (`484` assets / `643.0 KB` shell JS / `11`
lazy chunks); dedicated/full/adaptive Chromium E2E; secrets `1174`; history `311`. Unchanged manifests preserve the
authorized production audit at exact `0 vulnerabilities`.

Fresh disposable PostgreSQL project `easyboost-postgres-integration-21360` applied migrations `001–054` and passed
exact `47/47` in `11840.1889 ms`, including revision exhaustion with no rejected UUID ledger plus existing storage,
replay, export and deletion parity. Compose cleanup completed and exact container/volume/network label filters are
empty; Docker 28.0.1 is stopped with pipe absent. No provider/paid call, install, push, deploy or Ticket 05 occurred;
audit/FIPI exclusions and the Ticket 99 bank-expansion reminder remain intact. Ticket 04 stays `in-progress` pending
post-doc gates, a new raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local commit.

Ticket 04 twenty-second-remediation post-documentation verification preserves focused `102/102` and full unit
`1740 total / 1693 pass / 47` expected PostgreSQL skips / `0 fail`; an independent compact full-unit rerun exited
zero in `29.7099448 s`. Lint, generated OpenAPI, check (`410` JS / `211` handlers / `126` names), diff-check, build
(`484` assets / `643.0 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets `1174` and
history `311` are green. The authorized production audit remains exact `0 vulnerabilities` with unchanged manifests;
fresh live PostgreSQL remains `47/47`. Docker is stopped with pipe absent. The next boundary is the exclusion-safe
raw-byte freeze and two brand-new literal `ZERO_FINDINGS` reviews.

Ticket 04 twenty-first frozen-review remediation closes the final cross-tab authority and numeric-boundary gaps.
Both independent reviews of the prior freeze found that a focused tab could overwrite a newer assessment projection
from shared storage when the attempt draft revision had not changed; Spec also confirmed that an assessment already
at JavaScript's maximum safe integer could overflow and wrap on its next mutation. Exact RED was `144 total / 92
pass / 47` expected PostgreSQL skips / `5 fail`; affected GREEN is `144 total / 97 pass / 47` expected PostgreSQL
skips / `0 fail`.

Shared-storage reconciliation now compares `assessmentRevision` independently from the attempt draft revision: a
higher assessment revision wins atomically, a lower one is ignored, and an equal revision must contain the exact
same semantic assessment projection or the runner fails closed without overwriting memory or storage. The shared
domain permits `9007199254740990 → 9007199254740991`, then rejects every further assessment mutation with bounded
`ASSESSMENT_REVISION_EXHAUSTED` before changing the snapshot or settling its command ledger. File and PostgreSQL
share that contract, and OpenAPI fixes the public maximum at `9007199254740991`.

Pre-documentation gates are green: focused `144 total / 97 pass / 47` expected PostgreSQL skips / `0 fail`; full
unit `1737 total / 1690 pass / 47` expected PostgreSQL skips / `0 fail` in `39773.1582 ms`; lint; generated OpenAPI;
check (`410` JS / `211` handlers / `126` names); diff-check; build (`484` assets / `643.0 KB` shell JS / `11` lazy
chunks); dedicated/full/adaptive Chromium E2E; secrets `1174`; history `311`. The authorized production audit
remains exact `0 vulnerabilities` with unchanged manifests. Fresh disposable PostgreSQL project
`easyboost-postgres-integration-21608` applied migrations `001–054` and passed `47/47` in `13531.1844 ms`, including
the MAX_SAFE allow/reject/no-partial-ledger boundary. Compose cleanup completed and exact container/volume/network
label filters are empty; Docker 28.0.1 is stopped with pipe absent. No provider/paid call, install, push, deploy or
Ticket 05 occurred; audit/FIPI exclusions and the Ticket 99 bank-expansion reminder remain intact. Ticket 04 stays
`in-progress` pending post-doc gates, a new raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole
local commit.

Ticket 04 twenty-first-remediation post-documentation verification preserves focused `144 total / 97 pass / 47`
expected PostgreSQL skips / `0 fail` and full unit `1737 total / 1690 pass / 47` expected skips / `0 fail` in
`43135.8181 ms`. Lint, generated OpenAPI, check (`410` JS / `211` handlers / `126` names), diff-check, build (`484`
assets / `643.0 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets `1174` and history
`311` are green. The authorized production audit remains exact `0 vulnerabilities` with unchanged manifests; fresh
live PostgreSQL remains `47/47` because the post-boundary delta is documentation only. Docker is stopped with pipe
absent. The next boundary is the exclusion-safe raw-byte freeze and two brand-new literal `ZERO_FINDINGS` reviews.

Ticket 04 twentieth frozen-review remediation closes a cross-device stale immutable-replay regression. The prior
Spec review returned literal `ZERO_FINDINGS`; Standards found that an old frozen terminal run response could replace
a newer post-renewal assessment because assessment mutations do not advance the attempt draft revision. Exact RED
was `139 total / 88 pass / 46` expected PostgreSQL skips / `5 fail`; affected GREEN is `150 total / 104 pass / 46`
expected PostgreSQL skips / `0 fail`.

The server now persists a distinct monotonic `writing_assessment.assessment_revision`, bumps it for every
assessment/result/run-disposition mutation and projects it through current/named-attempt/result reads and frozen
command responses. OpenAPI requires the public `assessmentRevision`. The durable browser runner accepts a higher
revision, demands exact semantic equality at the same revision and preserves newer assessment state while still
validating and retiring an older immutable UUID. Shared file/PostgreSQL contracts and composed HTTP/browser tests
cover subscription block, explicit renewal/clear, newer GET and a lost old response replayed afterward.

Pre-documentation gates are green: full unit `1732 total / 1686 pass / 46` expected PostgreSQL skips / `0 fail` in
`32172.6749 ms`; lint; generated OpenAPI; check (`410` JS / `211` handlers / `126` names); diff-check; build (`484`
assets / `643.0 KB` shell JS / `11` lazy chunks); dedicated/full/adaptive Chromium E2E; secrets `1174`; history
`311`. The authorized production audit remains exact `0 vulnerabilities` with unchanged manifests. Default-sandbox
project `easyboost-postgres-integration-12424` was denied before daemon access; authorized disposable project
`easyboost-postgres-integration-23156` applied migrations `001–054` and passed `46/46` in `12935.386 ms`. Compose
cleanup and exact container/volume/network label filters are empty; Docker 28.0.1 is stopped with pipe absent. No
provider/paid call, install, push, deploy or Ticket 05 occurred; audit/FIPI exclusions and the Ticket 99
bank-expansion reminder remain intact. Ticket 04 stays `in-progress` pending post-doc gates, a new raw-byte freeze,
fresh literal ZERO×2, metadata closeout and its sole local commit.

Ticket 04 twentieth-remediation post-documentation verification preserves full unit `1732 total / 1686 pass / 46`
expected PostgreSQL skips / `0 fail` in `39386.7597 ms`. Lint, generated OpenAPI, check (`410` JS / `211` handlers /
`126` names), diff-check, build (`484` assets / `643.0 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive
Chromium E2E, secrets `1174` and history `311` are green. The authorized production audit remains exact `0
vulnerabilities` with unchanged manifests; fresh live PostgreSQL remains `46/46`. Docker is stopped with pipe absent.
The next boundary is the exclusion-safe raw-byte freeze and two brand-new literal `ZERO_FINDINGS` reviews.

Ticket 04 seventeenth frozen Standards/Spec remediation closed a server-durability reload loop and the assessment
module seam through exact RED `128 total / 118 pass / 10 fail` and affected GREEN `131/131`. An owner-locked
subscription rejection now stores `writing_assessment.run_disposition = subscription_required`; current, exact
attempt and result GETs project it without side effects, every tab/device adopts it, and no automatic replacement
UUID is created. Only an explicit learner action after renewal creates a new UUID and clears the block before
dispatch; frozen authorized recovery remains allowed. Browser acknowledgement validation requires the terminal
response and authoritative attempt disposition to agree before state/queue mutation. The full word/scope policy and
automatic warning contract moved to neutral shared modules with thin `public/` adapters, and the built/source
service-worker closure serves their canonical `/shared/...` URLs offline.

Pre-documentation gates are green: full unit `1730 total / 1684 pass / 46` expected PostgreSQL skips / `0 fail`;
lint; generated OpenAPI; check (`410` JS / `211` handlers / `126` names); diff-check; build (`484` assets / `643.0
KB` shell JS / `11` lazy chunks); dedicated/full/adaptive Chromium E2E; fresh authorized audit `0
vulnerabilities`; secrets `1174`; history `311`. The mandatory live boundary first attempted sandbox-denied
project `easyboost-postgres-integration-33592`; authorized project `easyboost-postgres-integration-25512` applied
migrations `001–054` and passed exact `46/46` in `12959.8507 ms`. Compose cleanup and six exact-label filters are
empty for both identities; Docker 28.0.1 is stopped with pipe absent. No provider/paid call, install, push, deploy or
Ticket 05 occurred; audit/FIPI exclusions and the Ticket 99 bank-expansion reminder remain intact. Ticket 04 stays
`in-progress` pending post-doc gates, raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local
commit.

Ticket 04 seventeenth-remediation post-documentation verification preserves affected GREEN `131/131` and full
unit `1730 total / 1684 pass / 46` expected PostgreSQL skips / `0 fail`. Lint, generated OpenAPI, check (`410` JS /
`211` handlers / `126` names), diff-check, build (`484` assets / `643.0 KB` shell JS / `11` lazy chunks),
dedicated/full/adaptive Chromium E2E, secrets `1174` and history `311` are green. The fresh authorized production
audit remains exact `0 vulnerabilities`; it and live PostgreSQL `46/46` remain applicable because the post-boundary
delta is documentation only. Docker remains stopped with its pipe absent. Next boundary is the exact exclusion-safe
raw-byte freeze and two brand-new literal `ZERO_FINDINGS` reviews.

Ticket 04 eighteenth frozen Standards/Spec remediation closed a cross-device renewal race and an executable
OpenAPI mismatch. Public RED was exact `91 total / 86 pass / 5 fail`, with a separate offline-command replacement
RED `1/0/1`; expanded affected GREEN is `104/104`. A pre-block pending automatic UUID and every new UUID without
`explicitRenewal:true` now terminalize the server-durable `subscription_required` disposition after renewal with
zero dispatch. Only the learner's explicit action creates a new payload/hash-bound UUID; the owner lock rechecks
active entitlement before clearing the block. The browser replaces a stale automatic command with that explicit
UUID even offline. OpenAPI rejects a nonterminal attempt carrying the nested terminal disposition and preserves
exact top-level/nested matching for applied/replayed subscription terminal responses.

Pre-documentation gates are green: full unit `1730 total / 1684 pass / 46` expected PostgreSQL skips / `0 fail`
in `33326.1921 ms`; lint; generated OpenAPI; check (`410` JS / `211` handlers / `126` names); diff-check; build
(`484` assets / `643.0 KB` shell JS / `11` lazy chunks); dedicated/full/adaptive Chromium E2E; secrets `1174`;
history `311`. The fresh authorized audit remains `0 vulnerabilities` with unchanged manifests. Disposable
PostgreSQL project `easyboost-postgres-integration-23936` applied migrations `001–054` and passed exact `46/46` in
`12564.9143 ms`, including stale A → B block → renewal → A no-dispatch terminal → unmarked terminal → explicit C.
Compose removed container/volume/network and three exact-label filters are empty. Docker 28.0.1 is stopped with pipe
absent. No provider/paid call, install, push, deploy or Ticket 05 occurred; audit/FIPI exclusions and the Ticket 99
bank-expansion reminder remain intact. Ticket 04 stays `in-progress` pending post-doc gates, raw-byte freeze, fresh
literal ZERO×2, metadata closeout and its sole local commit.

Ticket 04 eighteenth-remediation post-documentation verification preserves affected GREEN `104/104` and full unit
`1730 total / 1684 pass / 46` expected PostgreSQL skips / `0 fail` in `43244.0499 ms`. Lint, generated OpenAPI,
check (`410` JS / `211` handlers / `126` names), diff-check, build (`484` assets / `643.0 KB` shell JS / `11` lazy
chunks), dedicated/full/adaptive Chromium E2E, secrets `1174` and history `311` are green. The authorized production
audit remains exact `0 vulnerabilities` because manifests are unchanged; fresh live PostgreSQL remains `46/46`.
Docker is stopped with pipe absent. Next boundary is the exclusion-safe raw-byte freeze and two brand-new literal
`ZERO_FINDINGS` reviews.

Ticket 04 nineteenth frozen Standards/Spec remediation closed the final production transport gap. The built real
screen E2E first recorded RED `[{}]` versus expected `[{"explicitRenewal":true}]` after pressing the explicit
post-renewal button, then passed GREEN. The production adapter now forwards that marker only for strict runner input
`true`; automatic/stale commands still send `{}` and cannot clear the durable block. Full unit is `1730 total /
1684 pass / 46` expected PostgreSQL skips / `0 fail` in `35719.4924 ms`; lint, generated OpenAPI, check (`410` JS /
`211` handlers / `126` names), diff-check, build (`484` assets / `643.0 KB` shell JS / `11` lazy chunks),
dedicated/full/adaptive Chromium E2E, secrets `1174` and history `311` are green. Authorized audit remains `0`
vulnerabilities with unchanged manifests. Fresh PostgreSQL project `easyboost-postgres-integration-23936` remains
applicable at `46/46` because the post-boundary delta is browser screen/E2E/evidence only; Docker is stopped with
pipe absent. Exclusions and Ticket 99 remain intact. Ticket 04 stays `in-progress` pending a new raw-byte freeze,
fresh literal ZERO×2, metadata closeout and its sole local commit.

Ticket 04 sixteenth frozen Standards/Spec remediation resolved four coupled deep-seam findings through exact public
RED `116 total / 110 pass / 6 fail` and GREEN `116/116`. File and PostgreSQL now share one neutral command policy
for assessment-run begin/rejection/settlement/replay. A shared adapter contract proves that an expired subscription
without frozen authorization persists one UUID-bound `subscription_required` terminal acknowledgement, replays it
exactly and dispatches no provider work, while a previously frozen authorization remains recoverable. One neutral
browser-safe sanitizer owns text cleanup/reporting for server validation and the thin browser adapter. Runner terms
are now `writtenAnswers` and `flushAssessmentCommand`, with legacy names confined to storage normalization. The
five EGE modules plus shared sanitizer remain in the executable offline closure; `/shared` is routed before frontend
fallback, and executable OpenAPI owns both exact rejection branches.

After registering the shared file/PostgreSQL contract, focused storage is `63 total / 17 pass / 46` expected
PostgreSQL skips / `0 fail`; full unit is `1729 total / 1683 pass / 46` expected skips / `0 fail`. Lint, generated
OpenAPI grammar, check (`410` JS / `211` handlers / `126` names) and diff-check are green; the already-green build
(`484` assets / `643.0 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets `1174` and
history `311` remain applicable because the final pre-database delta was test-only. The mandatory live boundary
first attempted sandbox-denied project `easyboost-postgres-integration-25004` before resource creation; authorized
project `easyboost-postgres-integration-29132` applied migrations `001–054` and passed exact `46/46` in
`12739.1536 ms`. Compose cleanup completed; six exact-label container/volume/network filters are empty for both
identities, and Docker 28.0.1 is stopped with pipe absent. Manifests remain unchanged and the authorized audit stays
applicable at `0 vulnerabilities`. No provider/paid call, install, push, deploy or Ticket 05 occurred; audit/FIPI
exclusions and the Ticket 99 bank-expansion reminder remain intact. Ticket 04 stays `in-progress` pending post-doc
gates, raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local commit.

Ticket 04 sixteenth-remediation post-documentation gates preserve full unit `1729 total / 1683 pass / 46`
expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI grammar, check (`410` JS / `211` handlers / `126`
names), diff-check, build (`484` assets / `643.0 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium
E2E, secrets `1174` and history `311` are green. Live PostgreSQL remains exact `46/46`, and Docker remains stopped
with pipe absent. The scoped candidate is ready for its exclusion-safe raw-byte freeze and two new literal
`ZERO_FINDINGS` reviews.

Ticket 04 thirteenth frozen Standards/Spec remediation captured three public-contract findings. Initial public
RED was `95 total / 90 pass / 5 fail`, including one relative-URL mistake in the newly restored built-output worker
test corrected before production; all four behavioral failures closed at focused GREEN `95/95`. Assessment
run/retry HTTP responses are now validated before any local state replacement or durable queue retirement, so a
malformed terminal HTTP 200 preserves the same UUID, payload and prior attempt until a valid replay. Production
full-mock claims derive their task-specific provider/deployment-clamped ceiling from `limitsFor(writing_37|38)` and
use canonical `12`, never the unrelated global Writing route limit. The restored public build regression executes
the real built service worker, the derived five-module EGE closure and its generation marker without source/regex
implementation assertions. Full unit is `1723 total / 1678 pass / 45` expected PostgreSQL skips / `0 fail`; lint,
generated OpenAPI grammar, check (`406` JS / `211` handlers / `126` names), diff-check, build (`484` assets /
`643.0 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets `1174` and history `311` are
green. The mandatory boundary first attempted sandbox-denied project `easyboost-postgres-integration-14708`
before resource creation; authorized project `easyboost-postgres-integration-16604` applied migrations `001–054`
and passed exact `45/45` in `13327.1986 ms`. Compose cleanup completed and exact-label container/volume/network
filters for `16604` are empty; Docker 28.0.1 is stopped with pipe absent. Manifests are unchanged and the authorized
audit remains applicable at `0 vulnerabilities`. No provider/paid call, install, push, deploy or Ticket 05 occurred;
the unrelated audit worktree and ignored local FIPI extract remain excluded. Ticket 04 stays `in-progress` pending
post-doc gates, raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local commit. Ticket 99 remains
the explicit later reminder to expand the verified authored bank substantially.

Ticket 04 thirteenth-remediation post-documentation gates preserve focused `95/95` and full unit `1723 total /
1678 pass / 45` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI grammar, check (`406` JS / `211`
handlers / `126` names), diff-check, build (`484` assets / `643.0 KB` shell JS / `11` lazy chunks),
dedicated/full/adaptive Chromium E2E, secrets `1174` and history `311` are green. No runtime/storage/migration change
followed live PostgreSQL `45/45`; Docker remains stopped. The scoped candidate is ready for raw-byte freeze and two
fresh read-only literal `ZERO_FINDINGS` reviews, excluding the unrelated audit worktree and ignored local FIPI
context.

Ticket 04 fourteenth frozen Standards/Spec remediation resolved two final review findings. The built-output worker
test now activates the emitted worker, disables the network, fetches every derived hashed module from the five-path
EGE closure and rechecks the update generation marker; this test-first extension passed `12/12` immediately because
production behavior was already correct. EGE writing OpenAPI generation now lives in its task-specific module,
Grammar generation in its own module, both behind a shared schema editor and a small general orchestrator; the old
package-script filename is only a compatibility entry point. Focused tests are `95/95`; full unit is `1723 total /
1678 pass / 45` expected PostgreSQL skips / `0 fail`. Lint, generated OpenAPI grammar, check (`410` JS / `211`
handlers / `126` names), diff-check, build (`484` assets / `643.0 KB` shell JS / `11` lazy chunks),
dedicated/full/adaptive Chromium E2E, secrets `1174` and history `311` are green. Only test/generator architecture
changed, with no runtime/server/storage/migration/schema-output delta, so PostgreSQL project `16604` remains the
exact applicable live `45/45` boundary. Docker is stopped with pipe absent. No provider/paid call, install, push,
deploy or Ticket 05 occurred; audit/FIPI exclusions and the Ticket 99 bank-expansion reminder remain intact. Ticket
04 stays `in-progress` only for a new raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local
commit.

Ticket 04 fifteenth frozen Standards/Spec remediation resolved two coupled durable-browser findings. Public RED
`63 total / 62 pass / 1 fail` proved that terminal 409 plus an observational safe GET wrongly retired the pending
assessment UUID; GREEN is `63/63`, expanded `95/95`. Durable state is now accurately named `assessmentCommand`,
with one descriptor map owning run/retry validation, transport, payload and completion. Legacy unreleased field
names normalize once. Safe GET may adopt terminal projection but cannot advance the command watermark; only a valid
applied/replayed POST acknowledgement retires the exact UUID. Full unit is `1723 total / 1678 pass / 45` expected
PostgreSQL skips / `0 fail`; lint, generated OpenAPI grammar, check (`410` JS / `211` handlers / `126` names),
diff-check, build (`484` assets / `643.0 KB` shell JS / `11` lazy chunks), dedicated/full/adaptive Chromium E2E,
secrets `1174` and history `311` are green. Browser-only runtime/test changes leave PostgreSQL project `16604` the
exact applicable `45/45` boundary; Docker remains stopped. No provider/paid call, install, push, deploy or Ticket 05
occurred; exclusions and Ticket 99 reminder remain intact. Ticket 04 stays `in-progress` only for another raw-byte
freeze, fresh literal ZERO×2, metadata closeout and its sole local commit.

Ticket 04 first frozen Standards/Spec remediation: five unique findings were captured together through public TDD as RED `45 total / 39 pass / 6 fail` and closed GREEN `45/45`. Each item now durably prepares an owner/attempt/item-bound result token before provider I/O, atomically records the validated review and every physical call settlement before completion, and replays settlement/completion from that result without re-evaluating paid work. Every primary, fallback and format-repair call claims a separate stable durable AI budget slot before I/O; a replayed slot cannot call the provider again. The writing service is fail-closed without an explicit version-bound consent authority, and the bootstrap no longer owns a second inline consent rule. Server validation enforces the pinned task-38 communicative K1-zero implication over every applicable criterion and the total. Executable OpenAPI now matches runtime: position 37 is string/null with a 12,000-character ceiling, position 38 is string/null with a 20,000-character ceiling, and result position 37/38 is discriminated to exact `6`/`14` score maxima. The expanded affected contour is GREEN `104 total / 60 pass / 44` expected PostgreSQL skips / `0 fail`; full unit is `1693 total / 1649 pass / 44` expected PostgreSQL skips / `0 fail`. Lint; generated OpenAPI; check (`401` JavaScript files, `211` inline handlers / `126` names); build (`484` assets, `642.8 KB` shell JS, `11` lazy chunks); full and adaptive Chromium E2E; secrets (`1174`); history (`311`); and diff-check are green. Manifests are unchanged, so the previous explicitly authorized audit remains applicable at `0 vulnerabilities`; no fresh registry request was made.

The mandatory fresh PostgreSQL run used disposable project `easyboost-postgres-integration-27764`, applied migrations `001–054`, and passed `44/44`, including the updated shared prepare/record/complete persistence, replay, export and deletion contract. Compose removed the container, volume and network. A first default-sandbox attempt named `easyboost-postgres-integration-31616` was denied before daemon access; independent exact-label filters are empty for containers, volumes and networks for both project identities. The parent stopped Docker 28.0.1 and confirmed the daemon pipe absent. No provider/paid call, package install, push, deploy or Ticket 05 work occurred; `.scratch/product-readiness-audit/` remains untouched. Ticket 04 stays `in-progress` until post-doc gates, a new canonical freeze, fresh independent literal `ZERO_FINDINGS`×2 and the sole local commit; Ticket 99 remains the explicit later reminder to expand the verified authored bank substantially.

Ticket 04 second frozen Standards/Spec remediation captured four unique findings in one public RED `93 total / 86 pass / 7 fail` and closed them at focused GREEN `93/93`: claim renewal now fences the full fallback/repair workflow under the owner/attempt lock; the pinned first-criterion-zero implication is exact for both task 37 and task 38; one shared FIPI normalizer supplies official grouped-number, spaced-percent, hyphenated-form and contraction tokenization plus question/sentence-aware cutoffs to assessment and browser UI; and positions 37–38 reject new non-string drafts while bounded legacy string arrays are normalized once and surfaced for learner review. Before documentation, full unit was `1697 total / 1653 pass / 44` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`402` JavaScript files, `211` inline handlers / `126` names) and diff-check were green.

The required new PostgreSQL boundary first attempted default-sandbox project `easyboost-postgres-integration-32392`; it was denied before daemon access and created no resources. Authorized disposable project `easyboost-postgres-integration-1412` applied migrations `001–054` and passed exact `44/44`, including renewable-lease/fencing, FIPI/K1 and executable API/storage parity. Compose removed the container, volume and network; independent exact-label container/volume/network filters are empty for both `1412` and `32392`. The parent stopped Docker 28.0.1 and confirmed its pipe absent. No provider/paid call, package install, push, deploy or Ticket 05 work occurred; `.scratch/product-readiness-audit/` remains untouched. Ticket 04 remains `in-progress` pending post-doc gates, a canonical freeze, two fresh literal `ZERO_FINDINGS` reviews, metadata closeout and its sole local commit; Ticket 99 remains the explicit later bank-expansion reminder.

Ticket 04 post-documentation gates preserve full unit `1697 total / 1653 pass / 44` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`402` JavaScript files, `211` inline handlers / `126` names), diff-check, build (`484` assets, `642.8 KB` shell JavaScript, `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets (`1174` tracked files) and history (`311` commits) are green. Performance retained exactly four eager screens without EGE and measured LCP `304 ms`, CLS `0`, INP `96 ms`; the known `180.7 KB > 150 KB` first-load budget and `EXPECTED_OWNER_REQUIRED` harness assertion reproduce the documented base debt. Package manifests remain unchanged, so the explicitly authorized `0 vulnerabilities` audit remains applicable without a fresh registry call. The scoped tree is ready for canonical freeze and two fresh read-only reviews.

Ticket 04 third frozen Standards/Spec remediation captured six unique findings in public RED `100 total / 92 pass / 8 fail` and closed them at focused GREEN `100/100`: the shared official normalizer now handles slash forms, artificial repeat volume and exact copied assignment questions/headings while returning the exact whole-question/whole-sentence assessable fragment; the provider prompt consumes that fragment without claiming a raw first-N-word cutoff; OpenAPI accepts the exact task-38 275-word boundary extension; cross-tab state merges `assetResumePhase` atomically with its winning block timestamp; API and UI share one canonical `mode: experimental`, `scoreKind: approximate` warning contract; and unexpected worker/repository errors use the sanitized logger while expected domain errors stay quiet. A compatibility RED `1703 total / 1651 pass / 44` expected PostgreSQL skips / `8 fail` identified only legacy non-module component harnesses and the missing app-shell entry. Focused compatibility GREEN is `20/20`; final pre-documentation unit is `1703 total / 1659 pass / 44` expected PostgreSQL skips / `0 fail`.

Lint; generated OpenAPI; check (`403` JavaScript files, `211` inline handlers / `126` names); diff-check; build (`484` assets, `643.0 KB` shell JavaScript, `11` lazy chunks); dedicated/full/adaptive Chromium E2E; secrets (`1174` tracked files); and history (`311` commits) are green. Performance retained the four eager non-EGE screens and measured LCP `340 ms`, CLS `0`, INP `104 ms`; the known `180.7 KB > 150 KB` first-load budget and `EXPECTED_OWNER_REQUIRED` harness assertion reproduce documented base debt. Manifests remain unchanged, so the explicitly authorized `0 vulnerabilities` audit remains applicable without a fresh registry request.

The mandatory fresh PostgreSQL boundary first attempted default-sandbox project `easyboost-postgres-integration-17660`; Docker config/pipe access was denied before resources existed. Authorized disposable project `easyboost-postgres-integration-13456` applied migrations `001–054` and passed exact `44/44` in `11892.5547 ms`, including canonical public result, official boundary scope, safe worker logging and storage/export/delete parity. Compose removed its container, volume and network; independent exact-label container/volume/network filters are empty for both project identities. The parent stopped Docker 28.0.1 and confirmed its pipe absent. No provider/paid call, package install, push, deploy or Ticket 05 work occurred; `.scratch/product-readiness-audit/` remains untouched. Ticket 04 remains `in-progress` pending post-doc gates, raw-byte canonical freeze, two fresh literal `ZERO_FINDINGS` reviews, metadata closeout and the sole local commit. Ticket 99 remains the explicit later reminder to expand the verified authored bank substantially.

Ticket 04 third-remediation post-documentation gates preserve full unit `1703 total / 1659 pass / 44` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`403` JavaScript files, `211` inline handlers / `126` names), diff-check, build (`484` assets, `643.0 KB` shell JavaScript, `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets (`1174` tracked files) and history (`311` commits) are green. The scoped tree is ready for a raw-byte canonical freeze and two fresh read-only reviews.

Ticket 04 fourth frozen Standards/Spec remediation captured four unique findings in one public RED `54 total / 47 pass / 7 fail`, closed at focused GREEN `54/54` and expanded affected GREEN `69/69`. Provider requests and durable outcome replay now bind and revalidate the complete authored assignment/content and criteria reference/fingerprint before applying a score. The shared server/browser official normalizer excludes copied question blocks plus detected task-38 headings/subheadings and suppresses artificial repeated volume; the later seventh review narrows this to the official consecutive-identical-word rule. Source-mode service-worker update preservation derives the EGE entry's executable transitive closure and includes `/ege-writing-text.js`. OpenAPI evidence is executable-contract exact at five entries, `err|warn`, non-empty bounded title/note and bounded wrong/right text. Before PostgreSQL, full unit was `1705 total / 1661 pass / 44` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`403` JavaScript files, `211` inline handlers / `126` names), diff-check, build (`484` assets, `643.0 KB` shell JavaScript, `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets (`1174`) and history (`311`) were green. Performance measured LCP `300 ms`, CLS `0`, INP `96 ms`; the known `180.7 KB > 150 KB` budget and `EXPECTED_OWNER_REQUIRED` assertion reproduce base debt. Manifests remain unchanged, so the authorized `0 vulnerabilities` audit remains applicable without another registry request.

The fresh PostgreSQL boundary first attempted default-sandbox project `easyboost-postgres-integration-2392`, which was denied before resource creation. Authorized project `easyboost-postgres-integration-15568` applied migrations `001–054` and recorded RED `43/44`: PostgreSQL JSONB object-key ordering exposed an order-sensitive exact-binding comparison. The public storage seam recorded RED `7 total / 6 pass / 1 fail`; recursive semantic JSON comparison preserved exact keys, values and array order while accepting irrelevant object-key order and closed GREEN `7/7` for outcome binding and replay. Authorized project `easyboost-postgres-integration-31964` then applied `001–054` and passed exact `44/44` in `11854.3194 ms`. Compose cleanup completed; exact-label container/volume/network filters are empty for `2392`, `15568` and `31964`. The parent stopped Docker 28.0.1 and confirmed its pipe absent. No provider/paid call, install, push, deploy or Ticket 05 work occurred; `.scratch/product-readiness-audit/` remains untouched. Ticket 04 stays `in-progress` pending post-doc gates, raw-byte freeze, two fresh literal `ZERO_FINDINGS` reviews, metadata closeout and its sole local commit. Ticket 99 remains the explicit later reminder to expand the verified authored bank substantially.

Ticket 04 fourth-remediation post-documentation gates preserve full unit `1705 total / 1661 pass / 44` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`403` JavaScript files, `211` inline handlers / `126` names), diff-check, build (`484` assets, `643.0 KB` shell JavaScript, `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets (`1174` tracked files) and history (`311` commits) are green. One first-pass full-E2E harness race reloaded before the asynchronous `continue-writing` dispatch signalled durable completion; the regression now waits for task 37 before reload and verifies it again after restore, and dedicated/full reruns are green. Performance measured LCP `296 ms`, CLS `0`, INP `96 ms`; the unchanged `180.7 KB > 150 KB` budget and `EXPECTED_OWNER_REQUIRED` assertion reproduce base debt. The scoped tree is ready for raw-byte canonical freeze and two fresh read-only reviews.

Ticket 04 fifth frozen Standards/Spec remediation captured seven unique findings in public RED `81 total / 73 pass / 8 fail` and closed GREEN `81/81`; the expanded storage/API/provider/writing contour is GREEN `72/72`. Automatic prepared-outcome replay now performs only a non-paying durable provider lookup by the original idempotency key; unsupported/not-found recovery becomes explicit `ambiguous` and cannot auto-retry. Only a manual request with `acknowledgePossibleProviderRepeat: true` tombstones the old reservation and authorizes a new UUID, while its warning discloses possible repeated provider work and old uncertain call rows remain budget-counted. Every provider request/outcome and primary/fallback/repair budget claim binds before I/O to the exact form fingerprint, assignment/content reference, criteria reference/fingerprint and complete pinned snapshot through a persisted SHA-256 context fingerprint. Drift and recovered payloads fail closed before score application. The shared FIPI normalizer excludes task-37 envelope/date/address lines, uses structural task-38 headings, preserves decimal/abbreviation sentences, supports Unicode ellipsis and counts `21st-century` as one token. Executable OpenAPI owns exact completed/null `37 → 3/6` and `38 → 5/14` shapes and runtime feedback/evidence bounds; named source/regex assertions were replaced by executed transport, HTTP/OpenAPI, storage, worker/offline and browser seams.

Before documentation, full unit is `1705 total / 1661 pass / 44` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`403` JavaScript files, `211` inline handlers / `126` names), diff-check, build (`484` assets, `643.0 KB` shell JavaScript, `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets (`1174`), history (`311`) are green. Performance is LCP `296 ms`, CLS `0`, INP `96 ms`; known `180.7 KB > 150 KB` and `EXPECTED_OWNER_REQUIRED` remain base debt. Manifests are unchanged and the authorized audit remains applicable at `0 vulnerabilities`. The fresh PostgreSQL boundary first attempted denied project `easyboost-postgres-integration-1980` before resource creation; authorized project `easyboost-postgres-integration-14080` applied migrations `001–054` and passed `44/44` in `12474.2351 ms`. Compose cleanup completed and exact-label container/volume/network filters are empty for both identities; Docker 28.0.1 is stopped with pipe absent. No provider/paid call, install, push, deploy or Ticket 05 work occurred; `.scratch/product-readiness-audit/` remains untouched. Ticket 04 stays `in-progress` pending post-doc gates, raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local commit. Ticket 99 remains the explicit later reminder to expand the verified authored bank substantially.

Ticket 04 fifth-remediation post-documentation gates preserve public `81/81` and full unit `1705 total / 1661 pass / 44` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`403` JavaScript files, `211` inline handlers / `126` names), diff-check, build (`484` assets, `643.0 KB` shell JavaScript, `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets (`1174`) and history (`311`) are green. The scoped tree is ready for raw-byte canonical freeze and two fresh read-only reviews.

Ticket 04 sixth frozen Standards/Spec remediation captured seven unique findings and one deep-seam consolidation in public RED `109 total / 102 pass / 7 fail`, closed GREEN `109/109` and expanded affected GREEN `143/143`. One canonical exact-binding builder/validator now owns the form/assignment/content/criteria shape for provider, durable outcome, context fingerprint and contract tests. Any provider reservation followed by transport/timeout uncertainty persists `prepared_unknown`; automatic dispatch is lookup-only and unsupported/not-found becomes `ambiguous`, while only an explicit repeat-risk acknowledgement tombstones the old reservation and permits a new UUID. The initial owner-locked claim freezes authorization time, subscription expiry, consent decision and policy version, so its fenced work can reclaim/settle after entitlement expiry but a new assessment cannot start. Task 37 excludes only an anchored leading envelope, never ordinary numeric/address-word prose. Task 38 applies the pinned published-source overlap and complete K1 cascade. Browser retryable/ambiguous actions persist offline and through reload. OpenAPI discriminates completed numeric/two-completed-item shapes from incomplete null-score shapes with at least one unfinished item. The remaining source-level assertions were replaced by executed HTTP/storage/provider/worker/rendered behavior.

A final authored-table self-audit extended the same source rule through exact RED `39 total / 37 pass / 2 fail` and GREEN `39/39`: the pinned corpus is the flattened topic, row labels and percentages, so exact matches of at least ten words are visible even though each published row is short; the incomplete OpenAPI branch also rejects two completed items. Final pre-evidence full unit is `1714 total / 1669 pass / 45` expected PostgreSQL skips / `0 fail`. Lint, generated OpenAPI, check (`405` JavaScript files, `211` inline handlers / `126` names), diff-check, build (`484` assets, `643.0 KB` shell JavaScript, `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets (`1174`) and history (`311`) are green. Manifests remain unchanged and the prior explicitly authorized audit stays applicable at `0 vulnerabilities`.

The final PostgreSQL boundary first attempted default-sandbox project `easyboost-postgres-integration-8968`, denied before resource creation. Authorized project `easyboost-postgres-integration-24252` applied migrations `001–054` and passed exact `45/45` in `12472.2911 ms`, including frozen-authorization reclaim and complete writing-assessment storage/export/delete parity. Compose removed its container, volume and network; independent exact-label container/volume/network filters are empty for both identities. The parent stopped Docker 28.0.1 and confirmed its pipe absent. No provider/paid call, install, push, deploy or Ticket 05 work occurred; `.scratch/product-readiness-audit/` remains untouched. Ticket 04 stays `in-progress` pending final post-doc gates, raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local commit. Ticket 99 remains the explicit later reminder to expand the verified authored bank substantially.

Ticket 04 seventh frozen Standards/Spec remediation captured four unique findings in exact public RED `39 total / 34 pass / 5 fail`, closed GREEN `39/39`. Task 37 excludes only exact verbatim assignment-question tokens while learner lead-ins/labels stay countable; its start-anchored postal parser consumes structural headers/date/street/postcode plus up to two city/country lines and stops at greeting/prose. Only a consecutive run of at least three identical word tokens is collapsed; repeated multiword phrases remain fully counted. Executable OpenAPI binds each position to its exact maximum, criteria reference and task-aware scope, and a completed result requires the unique pair one task 37 plus one task 38. Full unit is `1714 total / 1669 pass / 45` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`405` JavaScript files, `211` inline handlers / `126` names), diff-check, build (`484` assets, `643.0 KB` shell JavaScript, `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets (`1174`) and history (`311`) are green. Manifests remain unchanged and the prior explicitly authorized audit stays applicable at `0 vulnerabilities`.

The required PostgreSQL boundary first attempted default-sandbox project `easyboost-postgres-integration-13600`, denied before resource creation. Authorized project `easyboost-postgres-integration-21992` applied migrations `001–054` and passed exact `45/45` in `12070.9625 ms`, including final normalizer and storage/export/delete parity. Compose removed its container, volume and network; independent exact-label container/volume/network filters are empty for both identities. The parent stopped Docker 28.0.1 and confirmed its pipe absent. No provider/paid call, install, push, deploy or Ticket 05 work occurred; `.scratch/product-readiness-audit/` remains untouched. Ticket 04 stays `in-progress` pending final post-doc gates, raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local commit. Ticket 99 remains the explicit later reminder to expand the verified authored bank substantially.

Ticket 04 eighth frozen Standards/Spec remediation captured eight actionable findings after authoritative adjudication kept the English FIPI rule at consecutive identical-word suppression only. Focused public TDD recorded RED `157 total / 105 pass / 7 fail / 45` PostgreSQL skips and closed GREEN `158 total / 113 pass / 0 fail / 45` skips. Provider range/K1 now distinguishes target `100–140`/`200–250` from official gradable shoulders `90–154`/`180–275`; exact copied questions are excluded without requiring `?`; unnumbered first-line prose ending Street/Road/Square is not an envelope. File/PostgreSQL claim derives current consent inside the owner lock and ignores stale caller booleans. Terminal UI uses the exact shared experimental/approximate warning. Terminal `409` reconciliation retires a stale offline retry when the server says `retryAllowed:false`. Executable OpenAPI pins exact status/warning branches, rubric fingerprints, criterion tuples and item/overall score sums. Full unit first found one stale provider test fixture at RED `1717 total / 1671 pass / 1 fail / 45` skips, then closed GREEN `1717 total / 1672 pass / 0 fail / 45` skips. Lint, OpenAPI generation check, check (`405` JS / `211` handlers / `126` names), diff-check, build (`484` assets, `643.0 KB`, `11` lazy chunks), dedicated/full/adaptive E2E, secrets `1174` and history `311` are green; unchanged manifests keep the explicitly authorized `0 vulnerabilities` audit applicable.

The mandatory final PostgreSQL boundary first attempted sandbox-denied project `easyboost-postgres-integration-30640` before resource creation. Authorized project `easyboost-postgres-integration-13912` applied migrations `001–054` and passed `45/45` in `11753.3122 ms`; Compose cleanup completed and independent exact-label container/volume/network filters are empty for both identities. Docker 28.0.1 is stopped with pipe absent. Provider/paid calls, install, push, deploy and Ticket 05 did not occur; `.scratch/product-readiness-audit/` remains untouched. Ticket 04 stays `in-progress` pending post-doc gates, raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local commit. Ticket 99 remains the explicit later reminder to expand the verified authored bank substantially.

Ticket 04 eighth-remediation post-documentation gates preserve full unit `1717 total / 1672 pass / 45` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`405` JS / `211` handlers / `126` names), diff-check, build (`484` assets, `643.0 KB`, `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets `1174` and history `311` are green. The scoped tree is ready for raw-byte canonical freeze and two fresh read-only literal `ZERO_FINDINGS` reviews.

Ticket 04 ninth frozen Standards/Spec remediation captured five unique findings. Public tests were added before
production and recorded RED `150 total / 146 pass / 4 fail`, then focused GREEN `128/128`; the shared export
lifecycle assertion was also test-first. Task 38 now excludes only exact published/structural or isolated
top-document headings, never an ordinary colon sentence in a full 180-word answer. One isomorphic sanitizer owns
browser persistence/counting and server assessment. Provider success makes its durable prepared token immediately
non-discardable across every later lease/persistence/settlement failure. File/PostgreSQL AI account export uses one
snake-case allowlist without owner/claim authority. Generated standard OAS3 `oneOf` branches enforce every pinned
ordered criterion vector, item sum and completed overall sum even with custom extensions removed. A compatibility
RED `239 total / 193 pass / 1 fail / 45` skips exposed one stale camel-case test and was corrected. Full unit is
`1719 total / 1674 pass / 45` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`406` JS /
`211` handlers / `126` names), diff-check, build (`484` assets, `643.0 KB`, `11` lazy chunks), dedicated/full/adaptive
Chromium, secrets `1174` and history `311` are green. Manifests remain unchanged and the authorized audit stays
applicable at `0 vulnerabilities`.

The mandatory PostgreSQL boundary first attempted sandbox-denied project
`easyboost-postgres-integration-11244` before resource creation. Authorized project
`easyboost-postgres-integration-34008` applied migrations `001–054` and passed exact `45/45` in `12258.2954 ms`;
Compose cleanup completed and independent exact-label container/volume/network filters are empty for both
identities. Docker 28.0.1 is stopped with pipe absent. Provider/paid calls, install, push, deploy and Ticket 05 did
not occur; `.scratch/product-readiness-audit/` remains untouched. Ticket 04 stays `in-progress` pending final
post-doc gates, canonical raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local commit.
Ticket 99 remains the explicit later reminder to expand the verified authored bank substantially.

Ticket 04 ninth-remediation final post-documentation verification preserves full unit `1719 total / 1674 pass /
45` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`406` JS / `211` handlers / `126` names),
diff-check, build (`484` assets, `643.0 KB`, `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets `1174`
and history `311` are green. No runtime/storage/migration/persistence change followed disposable PostgreSQL
`45/45`, so that live evidence remains final. Manifests are unchanged and the authorized audit remains applicable
at `0 vulnerabilities`. Ticket 04 remains `in-progress` only for raw-byte freeze, fresh literal ZERO×2, metadata
closeout and its sole local commit; Ticket 99 remains the later bank-expansion reminder.

Ticket 04 tenth frozen review remediation resolved the two executable-OAS findings and authoritative FIPI source
adjudication. Public TDD recorded exact RED `41 total / 38 pass / 3 fail` and GREEN `41/41`. Task 37 keeps only the
anchored pre-greeting From/To/Subject/address/date exclusion and counts greeting through signature; the corrected
English-FIPI extract no longer claims the opposite. Its artificial-volume rule remains a consecutive identical
word run, while task 38 also counts an adjacent repeated multiword combination once. Generated standard OAS3
branches now reject every K1-zero vector with later nonzero criteria, couple below-90/180 scope only to the all-zero
rubric, bind in-band `evaluatedWords` to `fullWords`, and bind overlength scope to the formal `140`/`250` cutoff while
the exact atomic boundary fragment remains retained. Expanded contour is GREEN `220 total / 175 pass / 45` expected
PostgreSQL skips / `0 fail`; full unit is `1719 total / 1674 pass / 45` / `0 fail`. Lint, generated OpenAPI, check
(`406` JS / `211` handlers / `126` names), diff-check, build (`484` assets / `643.0 KB` / `11` lazy chunks) and
dedicated/full/adaptive Chromium E2E are green.

Authority for that adjudication is the [FIPI 2026 English methodological recommendation](https://doc.fipi.ru/ege/dlya-predmetnyh-komissiy-subektov-rf/2026/angl_yaz_pch_mr_ege_2026.pdf),
word-count sections on pages 34 and 56: paraphrased, task 37 counts greeting through signature but not the sender
envelope, and task 38 additionally collapses consecutive repeated word combinations. The downloaded extract is
ignored local context only; runtime, tests, docs generation and commit content do not depend on it.

The fresh live boundary first attempted sandbox-denied project `easyboost-postgres-integration-29528` before any
resource existed. Authorized project `easyboost-postgres-integration-31384` applied migrations `001–054` and
passed exact `45/45` in `12076.3649 ms`; Compose cleanup completed and independent exact-label
container/volume/network filters are empty for both identities. Docker 28.0.1 is stopped with pipe absent.
Manifests remain unchanged and the authorized audit remains applicable at `0 vulnerabilities`. No provider/paid
calls, install, push, deploy or Ticket 05 occurred; `.scratch/product-readiness-audit/` remains untouched. Ticket 04
stays `in-progress` pending post-doc gates, raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole
local commit. Ticket 99 remains the explicit later reminder to expand the verified authored bank substantially.

Ticket 04 tenth-remediation post-documentation gates preserve full unit `1719 total / 1674 pass / 45` expected
PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`406` JS / `211` handlers / `126` names), diff-check,
build (`484` assets / `643.0 KB` / `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets `1174` and
history `311` are green. No runtime/storage/migration/persistence change followed the live `45/45` boundary. The
scoped tree is ready for raw-byte freeze and two fresh read-only literal ZERO reviews; Ticket 99 remains the later
bank-expansion reminder.

Ticket 04 eleventh frozen-review remediation captured three unique contract gaps. The prior Standards process pass
was discarded because it could not certify the excluded-directory access rule; only its independently reproducible
code evidence was used, and a completely fresh Standards review is required after remediation. Public TDD recorded
RED `114 total / 108 pass / 6 fail` and closed GREEN `114/114`. Safe current/attempt/result GETs are now strictly
observational and executable tests prove they perform zero writing claims/provider calls. Written submit persists
the pending job; the browser automatically queues the explicit owner-bound idempotent assessment-run POST, whose
UUID survives offline reload. Retryable and ambiguous acknowledged retries remain separate POST mutations.

One shared task-37 assessable-span seam now strips the anchored leading envelope, starts at the greeting or first
ordinary response line, ends at the recognized signature and excludes trailing text. Counting, cutoff, evaluated
answer, prompt, live UI and writing facts share it, so a valid envelope no longer produces a false missing-greeting
fact and text appended after the signature cannot inflate scope or reach the provider. AI operations and OpenAPI
document safe GET, explicit POST dispatch and task-specific repeat behavior. Full unit is `1721 total / 1676 pass /
45` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`406` JS / `211` handlers / `126` names),
diff-check, build (`484` assets / `643.0 KB` / `11` lazy chunks), dedicated/full/adaptive Chromium, secrets `1174`
and history `311` are green. Unchanged manifests keep the authorized `0 vulnerabilities` audit applicable.

The mandatory PostgreSQL boundary first attempted sandbox-denied project
`easyboost-postgres-integration-35140` before resource creation. Authorized project
`easyboost-postgres-integration-10188` applied migrations `001–054` and passed exact `45/45` in `12262.585 ms`.
Compose cleanup completed and independent exact-label container/volume/network filters are empty for both
identities. Docker 28.0.1 is stopped with pipe absent. No provider/paid call, install, push, deploy or Ticket 05
occurred; unrelated audit work remains unmodified and unstaged. Ticket 04 stays `in-progress` pending final post-doc
gates, candidate-only raw-byte freeze, fresh literal ZERO×2, metadata closeout and its sole local commit. Ticket 99
remains the explicit later reminder to expand the verified authored bank substantially.

Ticket 04 eleventh-remediation post-documentation gates preserve focused `114/114` and full unit `1721 total /
1676 pass / 45` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`406` JS / `211` handlers /
`126` names), diff-check, build (`484` assets / `643.0 KB` / `11` lazy chunks), dedicated/full/adaptive Chromium
E2E, secrets `1174` and history `311` are green. Retention/schema evidence now makes the observational GET and
durable explicit assessment-run POST boundaries unambiguous. No runtime/storage/migration/persistence change
followed the final live `45/45`, so Docker stays stopped. The candidate excludes the unrelated audit directory and
ignored local FIPI extract and is ready for canonical raw-byte freeze plus two completely fresh literal
`ZERO_FINDINGS` reviews; Ticket 99 remains the explicit bank-expansion reminder.

Ticket 04 twelfth frozen-review remediation captured three coupled public gaps. Public TDD recorded exact RED
`118 total / 114 pass / 4 fail`, closed focused GREEN `118/118`, and expanded GREEN `163 total / 118 pass / 45`
expected PostgreSQL skips / `0 fail`. Task 38 now collapses an adjacent repeated word or multiword combination from
its second occurrence, while task 37 keeps its documented word-only behavior. The owner-global mutation ledger
binds each assessment-run UUID to the exact operation, attempt and request hash: nonterminal delivery remains
resumable with the same UUID and returns `applied:false`; conflicts reject; only completed/retryable/ambiguous
terminal disposition freezes the exact response for immutable replay. The browser retains that UUID through
pending/in-progress responses, transport failure and offline reload, and clears it only after validated terminal
applied/replayed acknowledgement.

A composed real HTTP-plus-runner regression proves lost-worker `in_progress`, same-UUID recovery and terminal queue
retirement. Dedicated Chromium then exposed a production-facade RED: the source server omitted the new repository
begin/settle methods and returned `500`; wiring the shared db exports into the explicit server facade closed it.
Full unit is `1721 total / 1676 pass / 45` expected PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check
(`406` JS / `211` handlers / `126` names), diff-check, build (`484` assets / `643.0 KB` / `11` lazy chunks),
dedicated/full/adaptive Chromium E2E, secrets `1174` and history `311` are green. Manifests remain unchanged, so the
authorized `0 vulnerabilities` audit remains applicable without a fresh registry request.

The mandatory PostgreSQL boundary first attempted sandbox-denied project
`easyboost-postgres-integration-32344` before resource creation. Authorized project
`easyboost-postgres-integration-24096` applied migrations `001–054` and passed exact `45/45` in `12550.2122 ms`,
including the assessment-run ledger and full writing persistence/export/delete parity. Compose cleanup completed;
independent exact-label container/volume/network filters are empty for both identities. Docker 28.0.1 is stopped
with pipe absent. No provider/paid call, install, push, deploy or Ticket 05 occurred. The candidate excludes the
unrelated audit directory and ignored local FIPI context. Ticket 04 stays `in-progress` pending post-doc gates,
candidate-only raw-byte freeze, fresh literal `ZERO_FINDINGS`×2, metadata closeout and its sole local commit; Ticket
99 remains the explicit later bank-expansion reminder.

Ticket 04 twelfth-remediation post-documentation gates preserve full unit `1721 total / 1676 pass / 45` expected
PostgreSQL skips / `0 fail`; lint, generated OpenAPI, check (`406` JS / `211` handlers / `126` names), diff-check,
build (`484` assets / `643.0 KB` / `11` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets `1174` and
history `311` are green. A first full-unit pass run concurrently with other heavy checks hit one unrelated Speaking
timeout assertion; the immediate standalone full-suite rerun passed exactly and required no production change. No
runtime/storage/migration/persistence change followed live PostgreSQL `45/45`; Docker stays stopped. The candidate
excludes the unrelated audit worktree and ignored local FIPI context and is ready for raw-byte freeze plus two fresh
read-only literal `ZERO_FINDINGS` reviews. Ticket 99 remains the explicit bank-expansion reminder.

| Ticket | Результат | Статус |
|---|---|---|
| 01 | Версионированный эталонный авторский вариант | done |
| 02 | Owner-bound попытка, строгие таймеры и persistence/API | done |
| 03 | Единый письменный runner заданий 1–36 | done |
| 04 | Задания 37–38 и честная предварительная оценка | done |
| 05 | Устная часть 1–4 и предварительная оценка | done |
| 06 | Итог 82, прогноз, разбор и тренировочный повтор | done |
| 07 | PWA/E2E/release hardening полного пробника | done |
| 99 | Существенно расширить проверенный авторский банк | needs-triage; после 07 |

Решения 2026-08-13: полный формат; одна попытка с раздельно запускаемыми письменной и устной частями; строгие deadlines 190 и 17 минут; только проверенный авторский контент; один эталонный form в первом релизе; развёрнутые ответы получают явно предварительную автоматическую оценку; первый проход диагностический, повторы после раскрытия ключей тренировочные. В финале серии обязательно напомнить владельцу о Ticket 99.

Ticket 01 evidence: immutable `ege-en-2026-form-1@1` закрепляет 42 позиции, матрицу `12+12+18+20+20=82`, exact versioned content/criteria refs, pinned form/asset/criteria fingerprints и статическую answer-free browser projection. TDD завершён на `8/8` focused; полный suite — `1576 total / 1534 pass / 42` штатных PostgreSQL skip / `0 fail`; lint, check (`386 JS`, `211` handlers, `126` names), frontend build (`484` assets, `11` lazy chunks), catalog freshness, secret/history scans и diff-check зелёные. Package manifests, OpenAPI, storage и старые catalog snapshots не менялись; Docker/E2E/provider calls/install/push/deploy не требовались. Fresh Standards и Spec reviews вернули literal `ZERO_FINDINGS` на frozen tree `5b4fbd5d095f71df4da45d1efe6c2651e12983a7`.

Ticket 02 final evidence: owner-bound attempt lifecycle, immutable start snapshot, diagnostic/training split, versioned answer-free timing policy `ege-mock-attempt-policy-v1` (`190m + 30d oral-start window + 17m`), CAS draft, exact owner-global replay/conflict, complete authoritative part digests including blank positions, bounded assessment retry and safe result gating are implemented through one file/PostgreSQL contract and exact `/api/v1/ege-mocks` routes. Initial focused lifecycle passed `14/14`; four fresh-review findings were captured as exact RED `15 total / 8 pass / 7 intended fail` and closed at GREEN `15/15`, including the shared file mutation helper and transactionally reconciled export in both backends. A later Spec review exposed stale request-time clock capture before the file queue: a real queued HTTP RED `0/1` returned `200` after crossing the deadline, then GREEN `16/16` passed a clock thunk and sampled it only inside the file queue, matching PostgreSQL's after-owner-lock authority. Final Standards/Spec feedback required pure shared lifecycle operations plus both concurrent submit races: RED `2 total / 1 pass / 1 fail` → GREEN `17/17`; `attempt.js` owns every mutation guard/transition/result, and the shared file/live-PG contract proves exactly one written and oral winner plus one persisted/exported receipt. The last residual start/current duplication was captured by a direct domain RED `0/1` → GREEN `18/18`; `egeMockStartDecision` alone owns active-state selection, diagnostic-to-training mode and attempt numbering, and adapters only serialize/lock/reconcile/replay/persist. A final public-surface RED `0/1` proved raw transitions/digests/normalizers/durations were importable; GREEN retained `18/18` with only guarded lifecycle/apply/reconcile/start-decision/projection seams exported. A final executable-OpenAPI RED `0/1` then proved `EgeMockNullableAttempt` rejected the valid empty-current `attempt: null`; a null-only/reference `oneOf` and parity assertions for null, populated and invalid empty attempts produced HTTP/OpenAPI GREEN `3/3` while the focused contour remained `18/18`. The next full Standards pass caught invalid OpenAPI 3.0 `type: null` for a blank draft answer: exact RED `0/1` prohibited that keyword, then the valid nullable null-only branch returned GREEN `1/1`; executable parity accepts string/array/null answers and rejects boolean/object/forbidden-position shapes, with the full focused contour still `18/18`. Final full unit is `1596 total / 1552 pass / 44` expected no-DB skips / `0 fail`. Final disposable PostgreSQL project `easyboost-postgres-integration-36860` applied migrations `001–053` and passed `44/44`; compose removed its container/network/volume and three independent exact-label filters were empty. That PostgreSQL evidence remains applicable because the later remediation changed only documentation, executable OpenAPI and its parity test, leaving route/runtime validation/domain/repository/migration/persistence untouched. Docker Desktop was stopped by the parent task and the daemon pipe was absent. Lint, check (`391 JS`, `211` handlers / `126` names), generated OpenAPI check, frontend build (`484` assets / `11` lazy chunks), secret scan (`1156` tracked files), history scan (`309` commits) and diff-check are green. Manifests are unchanged, so no fresh dependency audit was required; no browser/provider calls, install, push or deploy occurred. Fresh full Standards and Spec reviews both returned literal `ZERO_FINDINGS` on deterministic bytewise identity `9dde7fdaedf2930a9ff5f162af8d1ae478eaf844fae096051c96c431168f6344`; Ticket 02 is done and Ticket 03 is next.

Ticket 03 implementation checkpoint: единый answer-free runner позиций `1–36` владеет strict server
deadline, semantic omissions, exact owner/form restore, per-answer monotonic cross-tab merge, CAS autosave
и durable idempotent draft/submit queue. Ручное завершение 1–36 сохраняет server-confirmed objective
draft-checkpoint, не сдавая будущие 37–38; только authoritative deadline reconciliation закрывает всю
письменную часть. Deadline closure принимает server truth, снимает superseded queue и явно сообщает о
непринятых offline changes. Monotonic watermark и compaction сохраняют ambiguous UUID, но ограничивают
очередь и tombstones даже после сотен reload/edit. Listening/reading unique selection и persisted bounded
audio-play переиспользуют существующие deep section modules. Preflight до старта проверяет `20` MP3 по
MIME/bytes/SHA-256; playback URL и service worker привязаны к exact form+fingerprint+asset digest,
различают revision-cache с одинаковым путём и отдают offline Range без network/generic fallback.
Публичные RED закрыли отсутствие runner, preflight/start ordering, offline reload, ambiguous start/save,
deadline submit with blanks, all-position roundtrip, warning bands, durable-storage failure и invalid
server timing. Review-remediation import/service-worker RED был `4 total / 1 pass / 3 fail`; отдельный
browser audio-contract RED завершился timeout. Следующая fresh double review дала RED
`24 total / 17 pass / 7 fail` для раннего whole-submit, bounded state и terminal restore, затем два
follow-up seam дали RED `0/2`. Следующая canonical double review дала adversarial RED `29/33` для exact
draft acknowledgement, client-early deadline, offline cache loss и long-offline exact-attempt restore;
следующая frozen-index проверка воспроизвела ещё два public RED для repeated early deadline и failed
online re-preflight; monotonic cancellation watermark и fail-closed `asset_blocked` закрыли их. Всё
это закрыто; следующий Standards adversarial набор дал RED `31/36` для overlapping checkpoint/CAS,
controlling SW, concurrent preflight и terminal cross-tab merge. Следующая полная двойная ревизия раскрыла
ещё cross-tab atomic persistence/asset block/stale start, dirty-position CAS, strict policy/timing/watermark,
exact form cache, owner invalidation, transient deadline retry, live omission status и playback lease: общий
публичный RED `31/42` закрыт финальным focused GREEN `52/52`.
Checkpoint intent переживает conflict; preflight требует exact-capable controlling SW и Web Lock, а
same-form tabs переиспользуют один полный verified cache. Terminal envelope восстанавливается без cache и онлайн
перепроверяется через `/attempts/{attemptId}`, включая authoritative `expired`; running-попытка онлайн
повторяет exact preflight без второго start, а offline cache loss даёт durable non-runnable state. Dedicated Chromium
проверил keyboard, reduced motion, `>=44px`, 320/1440 no-overflow, real offline `206`, shared two-play
audio, reload/CAS/reconnect и durable 1–36 checkpoint; реальный HTTP seam проверил answer-free
`oral_ready` после offline deadline; отдельный two-page owner-switch E2E сбрасывает старую authority и не
оставляет ответы другого владельца на экране. Full+adaptive Chromium также зелёные. Последний полный unit — `1645`
total (`1601` pass + `44` штатных PostgreSQL skip, `0` fail); lint/check (`399` JS, `211` handlers,
`126` names), build (`483` assets, `683.1 КБ` shell JS, `10` lazy chunks), secrets (`1173` tracked),
history (`310` commits), fresh authorized audit
(`0 vulnerabilities`) и diff-check зелёные. Один параллельный full-unit gate поймал известный несвязанный
Speaking timing transient `service_hung`; изолированный полный rerun зелёный. Изменений server/repository/validation/migration нет, поэтому
новый PostgreSQL/Docker прогон не нужен. Provider/install/push/deploy не выполнялись; Ticket 04 не
начинался. Код готов к canonical freeze и двум свежим независимым review.

Возобновлённый final review-remediation Ticket 03 зафиксировал публичный RED `43/52` ровно для девяти
оставшихся seam: start-lock readiness, exact offline policy/timing, monotonic deadline, overlapping ACK,
built form path, transient `503`, focus-safe projection, old-owner DOM reset и deletion purge. GREEN —
`52/52`; общий deletion/offline contract — `60/60`. Актуальный полный unit — `1654 total / 1610 pass / 44`
штатных PostgreSQL skip / `0 fail`; lint/check (`399` JS, `211` handlers / `126` names), production build
(`483` assets, `688.1 КБ`, `10` lazy chunks) с реально подставленным hashed exact-form path,
dedicated/full/adaptive Chromium, secrets (`1173`), history (`310`) и diff-check зелёные. Fresh authorized
audit `0 vulnerabilities` остаётся применимым, потому что manifests не менялись. Server/repository/
validation/migration не затрагивались, Docker/PostgreSQL не требуются; provider/install/push/deploy и
Ticket 04 не выполнялись. Следующий шаг — canonical freeze и две свежие независимые проверки.

Финальный performance/timer review-remediation Ticket 03 зафиксировал публичный RED для быстрых
клиентских часов, отсутствующего HTTP server-time, ошибочного пятого eager-screen и мёртвого `writerId`.
GREEN передаёт стандартный HTTP `Date` как non-enumerable metadata, пинит подписанный server offset и
продолжает время monotonic/offline; EGE screen/runner/preflight приезжают существующим lazy loader, а shell
держит только малый exact continuation contract. Focused+security — `140/140`; полный unit —
`1655 total / 1611 pass / 44` штатных PostgreSQL skip / `0 fail`; lint/check (`400` JS, `211` handlers /
`126` names), build (`484` assets, `641.6 КБ`, `11` lazy chunks), dedicated/full/adaptive Chromium,
secrets (`1173`) и history (`310`) зелёные. Performance first-load подтверждает ровно четыре eager screen
и отсутствие EGE. Оставшийся historical debt воспроизведён на чистом base `fc14cddd` без Ticket 03:
`178.8 КБ > 150 КБ` и тот же `EXPECTED_OWNER_REQUIRED`; текущий размер `180.6 КБ`, бюджет не повышался,
унаследованный harness/server не менялись. Audit `0 vulnerabilities` применим, manifests неизменны.
Server/repository/validation/migration не затрагивались; Docker/PostgreSQL/provider/install/push/deploy и
Ticket 04 не выполнялись. Следующий шаг — canonical freeze и две свежие независимые проверки.

Последний frozen review Ticket 03 выявил forward wall-clock jump после server anchor, задержку
owner-deletion notification за CacheStorage purge, глобальный radio refresh, необработанный exact-form
import failure и Back без route leave-hook. Публичный RED `108/112` закрыт GREEN `112/112`: timer после
authoritative anchor движется только monotonic elapsed, tombstone немедленно отзывает authority до
best-effort purge, projection ограничен EGE root, точная форма имеет fail-closed retry без старта таймера,
а Back запускает стандартные hooks и снимает expanded frame. Dedicated Chromium проверяет и failed exact
chunk → retry, и обычный Back; полный и adaptive Chromium зелёные. Полный unit — `1657 total / 1613 pass /
44` штатных PostgreSQL skip / `0 fail`; lint/check (`400` JS, `211` handlers / `126` names), build (`484`
assets, `641.6 КБ`, `11` lazy chunks), secrets (`1174`), history (`310`) и diff-check зелёные. Performance
снова показывает четыре eager screen без EGE; текущие `180.3 КБ > 150 КБ` и `EXPECTED_OWNER_REQUIRED`
остаются воспроизведённым на чистом base historical debt. Audit `0 vulnerabilities` применим, manifests
после него не менялись. Server/repository/validation/migration не затрагивались; Docker/PostgreSQL/provider/
install/push/deploy и Ticket 04 не выполнялись. Следующий шаг — canonical freeze и fresh ZERO×2 review.

Следующий fresh double review Ticket 03 нашёл ещё две границы: SW activation удаляла runtime-кэш
ленивого runner, а missing exact attempt/другая server `ownerGeneration` могла сохранить на экране private
ответы старой инкарнации. Публичный RED `53/57` закрыт GREEN `57/57`: отдельный versioned executable-cache
до `skipWaiting` получает новую hashed runner-ревизию только для уже открывавшего EGE клиента; lifecycle
VM доказывает install → activate → offline fetch, не добавляя EGE к чистой первой загрузке. Runner требует,
сохраняет и валидирует server `ownerGeneration`; `404`, mismatch или legacy envelope без identity удаляет
exact local state, очищает DOM и показывает безопасный retry. Полный unit — `1660 total / 1616 pass / 44`
штатных PostgreSQL skip / `0 fail`; lint/check (`400` JS, `211` handlers / `126` names), build (`484` assets,
`641.6 КБ`, `11` lazy chunks), dedicated/full/adaptive Chromium, secrets (`1174`), history (`310`) и
diff-check зелёные. Performance сохраняет четыре eager screen без EGE; `180.5 КБ > 150 КБ` и
`EXPECTED_OWNER_REQUIRED` — тот же подтверждённый на чистом base historical debt. Audit `0 vulnerabilities`
применим, manifests неизменны. Server/repository/validation/migration не менялись; Docker/PostgreSQL/
provider/install/push/deploy и Ticket 04 не выполнялись. Следующий шаг — новая freeze и fresh ZERO×2.

Последний pre-freeze review-remediation Ticket 03 закрыл четыре независимые границы публичным RED
`56/60` → GREEN `60/60`. Activation повторно проверяет прежний runtime-кэш непосредственно перед его
удалением, поэтому install → позднее открытие EGE → activate сохраняет новую exact executable revision.
Retryable `503` при restore больше не обходит asset readiness: потерянный exact cache переводит попытку в
durable `asset_blocked`. Браузер без local envelope сначала запрашивает authoritative `current`, принимает
активную попытку с exact policy/190-minute deadline и preflight, а только настоящий `null` оставляет idle.
Каждая lazy-import/restore/action/autosave/timer completion привязана к immutable owner+epoch token и перед
commit/render повторно сверяет authority, поэтому ABA owner switch не может оживить старый runner или
инвалидировать нового владельца. E2E новой вкладки теперь прямо подтверждает adoption уже идущей попытки.
Полный unit — `1663 total / 1619 pass / 44` штатных PostgreSQL skip / `0 fail`; lint/check (`400` JS,
`211` handlers / `126` names), build (`484` assets, `641.6 КБ`, `11` lazy chunks), dedicated/full/adaptive
Chromium, secrets (`1174`), history (`310`), diff-check и fresh authorized audit (`0 vulnerabilities`)
зелёные. Performance сохраняет четыре eager screen без EGE; текущие `180.5 КБ > 150 КБ` и
`EXPECTED_OWNER_REQUIRED` повторно воспроизведены тем же запуском на изолированном чистом base
`fc14cddd` (`178.8 КБ > 150 КБ`), поэтому остаются historical debt вне Ticket 03. Server/repository/
validation/migration не менялись; Docker/PostgreSQL/provider/install/push/deploy и Ticket 04 не
выполнялись. Следующий шаг — canonical freeze и fresh ZERO×2.

Финальная authority/activation remediation Ticket 03 закрыла ещё три review-находки. Transport retry
теперь допускает только явный `NETWORK_ERROR`/status `0`, `429` и конечный `>=500`; status-less integrity
и owner mismatch всегда fail-closed. Все EGE durable commits, включая ответы без network await и ответы
на delayed restore/autosave, проходят после form-lock через общий durable owner-incarnation lock и повторно
сверяют immutable runner/owner authority: concurrent tombstone+purge выигрывает и старый callback не может
воссоздать localStorage. Offline continuation использует durable generation guard, не требуя in-memory sync
owner. Service worker хранит versioned EGE-open marker, а при любом настоящем обновлении с active worker
заранее загружает новую exact executable revision на install; activation-open TOCTOU больше не зависит от
одного снимка старых cache keys, при этом чистая первая установка EGE не загружает. Начальный review RED
был `54/56` (две исполняемые гонки), скорректированный status-less seam также закреплён; финальный focused
контур — `64/64`. Полный unit — `1667 total / 1623 pass / 44` штатных PostgreSQL skip / `0 fail`;
lint/check (`400` JS, `211` handlers / `126` names), build (`484` assets, `642.4 КБ`, `11` lazy chunks),
dedicated/full/adaptive Chromium, secrets (`1174`), history (`310`) и diff-check зелёные. Fresh audit
остаётся `0 vulnerabilities`, manifests после него не менялись. Performance снова показал ровно четыре
eager screen без EGE; `180.5 КБ > 150 КБ` и `EXPECTED_OWNER_REQUIRED` совпадают с уже подтверждённым
на base historical debt. Server/repository/validation/migration не менялись; Docker/PostgreSQL/provider/
install/push/deploy и Ticket 04 не выполнялись. Следующий шаг — новая canonical freeze и fresh ZERO×2.

Последняя публичная remediation Ticket 03 закрыла clean-install/update различение service worker,
fail-closed восстановление при неизвестном server `current` и межвкладочную resurrection после definitive
invalidation. Worker фиксирует наличие active predecessor до install, не загружает EGE на чистой первой
activation и не повторяет полный executable preload без сети. Missing/owner-invalid attempt под общими
form + durable owner locks повышает отдельный invalidation watermark и удаляет envelope; storage event
скрывает старую вкладку, а все её дальнейшие commits/refresh отклоняются до записи. Empty-local `503`
показывает только noninteractive retry, без стартовой кнопки и редактирования; dedicated Chromium проверяет
и этот отказ, и успешный retry. Public RED `61/66` закрыт GREEN `66/66`. Полный unit — `1669 total / 1625
pass / 44` штатных PostgreSQL skip / `0 fail`; lint/check (`400` JS, `211` handlers / `126` names), build
(`484` assets, `642.8 КБ`, `11` lazy chunks), dedicated/full/adaptive Chromium, secrets (`1174`), history
(`310`) и diff-check зелёные. Performance удерживает четыре eager screen без EGE (LCP `312 ms`, CLS `0`,
INP `96 ms`); исторические `180.6 КБ > 150 КБ` и `EXPECTED_OWNER_REQUIRED` по-прежнему совпадают с
изолированно воспроизведённым base debt. Fresh authorized audit `0 vulnerabilities` применим, manifests
не менялись. Server/repository/schema/migration не менялись; Docker/PostgreSQL/provider/install/push/deploy
и Ticket 04 не выполнялись. Следующий шаг — canonical freeze и fresh ZERO×2.

Следующая review-remediation Ticket 03 сделала invalidation success-only и переживающей teardown service
worker. Captured watermark сверяется внутри form + owner locks прямо перед delete, поэтому delayed stale
callback не удаляет replacement attempt. Для quota сначала удаляется большой envelope, затем сохраняется
маленький tombstone; failed marker восстанавливает exact envelope, а failed marker/lock показывает только
noninteractive unavailable retry. Install-time clean/update decision хранится в отдельном per-shell cache и
читается новым worker global на activation. Public RED `63/67` закрыт GREEN `67/67`; полный unit — `1670
total / 1626 pass / 44` штатных PostgreSQL skip / `0 fail`. Lint/check (`400` JS, `211` handlers / `126`
names), build (`484` assets, `642.8 КБ`, `11` lazy chunks), dedicated/full и standalone adaptive Chromium,
secrets (`1174`), history (`310`) и diff-check зелёные. Один параллельный adaptive запуск поймал прежний
timing timeout скрытого `#home_adaptive_plan`; немедленный standalone rerun зелёный и Ticket 03 не затрагивает.
Performance сохранил четыре eager screen без EGE (LCP `308 ms`, CLS `0`, INP `96 ms`); `180.6 КБ > 150
КБ` и `EXPECTED_OWNER_REQUIRED` остаются подтверждённым base debt. Authorized audit `0 vulnerabilities`
применим, manifests неизменны. Server/repository/schema/migration не менялись; Docker/PostgreSQL/provider/
install/push/deploy и Ticket 04 не выполнялись. Следующий шаг — canonical freeze и fresh ZERO×2.

Последний frozen double review Ticket 03 независимо выявил одну двустороннюю install-time гонку service
worker: retained `clean` позволял update пропустить executable preload, а retained `update` нарушал lazy
clean reinstall. Публичный service-worker RED `8/10` закрыт GREEN `11/11`. Follow-up
equal-timestamp/clock-rollback RED `10/11` закрыт GREEN `11/11`: install под
origin-wide lock атомарно выделяет durable монотонное mode generation до preservation, использует captured
predecessor bit для своего решения, а activation после worker teardown выбирает единственное последнее
поколение и fail-closed отклоняет неоднозначность, поэтому delayed older write и wall clock не меняют новый
результат. Следующий source-mode stable-cache RED `11/12` доказал stale offline runner после update и после
clean re-registration с retained-open evidence; GREEN `12/12` заставляет любой реально нужный install-time
preservation атомарно refresh все executable paths независимо от стабильных ключей. Genuine clean/no-open
install остаётся lazy, а activation строго cache-only.
Общий focused runner/SW/UI контур — `71/71`; полный unit — `1674 total / 1630 pass / 44` штатных PostgreSQL
skip / `0 fail`; lint/check (`400` JS, `211` handlers / `126` names), build (`484` assets, `642.8 КБ`, `11`
lazy chunks), dedicated/full/adaptive Chromium, secrets (`1174`), history (`310`) и diff-check зелёные.
Первый full E2E rerun поймал timing-flake неизменённого Speaking task 3 TTS; точный Speaking rerun и следующий
полный последовательный rerun зелёные. Performance сохраняет четыре eager screen без EGE: LCP `284 ms`, CLS
`0`, INP `88 ms`; прежние `180.6 КБ > 150 КБ` и `EXPECTED_OWNER_REQUIRED` остаются подтверждённым base debt.
Authorized audit `0 vulnerabilities`
применим, manifests неизменны. Server/repository/schema/migration не менялись; Docker/PostgreSQL/provider/
install/push/deploy и Ticket 04 не выполнялись. Следующий шаг — canonical freeze и fresh ZERO×2.

Ticket 03 final closeout: независимые Standards и Spec review вернули буквальный `ZERO_FINDINGS` на одной
canonical frozen identity `b472186eaf1d0d206f97d50b56c5c6d2f2bb0cb3` при base/HEAD
`fc14cddd2036d7d4fd17f01f44b141fb40202305`. После этой identity изменены только status/evidence metadata.
Ticket 03 отмечен `done`; Ticket 04 остаётся следующим и не начинался. Единственный локальный commit закрывает
тикет без push/deploy/provider/install/Docker действий; reminder Ticket 99 о существенном расширении
проверенного авторского банка остаётся после Ticket 07.

Ticket 04 pre-freeze checkpoint: authored задания `37–38` теперь продолжают ту же строгую письменную
попытку после server-confirmed objective checkpoint; только явная полная сдача либо точная граница `190m`
закрывает позиции `1–38`. Accessible editors показывают official-compatible assignment, word count/range и
безопасные названия критериев без ключей; exact offline draft, reload, UUID replay, conflict rebase и asset
recovery сохраняют writing phase. Server-owned provisional assessment связывает работу с owner/form/criteria
snapshot, current text consent и durable AI slot, использует deterministic zero ниже 90% lower bound,
проверяет rubric output повторно на сервере, сохраняет full/evaluated answer и truncation только приватно,
публикует `6+14` criterion evidence/feedback лишь после обеих частей и честно оставляет provider failure
retryable с `null` score. Expired worker lease reclaim не повторяет completed item, а once-authorized claim
может owner/token-bound settle после subscription expiry без второй платной оценки.

Публичные RED→GREEN seams закрыли domain/service/storage/API/browser/UI, writing-phase deadline submit,
form-typed draft, result-read lease reclaim и entitlement-bound settlement. Focused contour — `93/93`; полный
unit — `1689 total / 1645 pass / 44` ожидаемых PostgreSQL skip / `0 fail`. Lint/check (`401` JS,
`211` handlers / `126` names), generated OpenAPI, build (`484` assets, `642.8 КБ`, `11` lazy chunks),
dedicated/full/adaptive Chromium, secrets (`1174`), history (`311`) и diff-check зелёные. Performance:
LCP `288 ms`, CLS `0`, INP `88 ms`; известные `180.7 КБ > 150 КБ` и `EXPECTED_OWNER_REQUIRED` остаются
подтверждённым base debt и не включают eager EGE screen. Manifests неизменны, применим предыдущий
authorized audit `0 vulnerabilities`.

Первый live PostgreSQL run применил `001–054` и дал точный RED `43/44` на JSONB `null` вместо SQL `NULL`;
после исправления адаптера disposable project `easyboost-postgres-integration-10144` применил `001–054` и
прошёл `44/44` с shared claim/complete/result/export/delete parity. Compose удалил container/volume/network,
три независимых exact-label filters пусты; координатор остановил Docker и подтвердил отсутствие pipe.
Provider/платных вызовов, install, push, deploy и Ticket 05 не было; `.scratch/product-readiness-audit/`
сохранён нетронутым. Ticket 04 остаётся `in-progress` до post-doc gates, canonical freeze, fresh ZERO×2 и
единственного локального commit; Ticket 99 reminder остаётся после Ticket 07.

---

## Grammar 2.0 — active mastery system

Spec: `.scratch/grammar-2/spec.md`

Overall status: `done` — Grammar 2.0 Tickets 01–08 are complete.

Final closeout Grammar 2.0 / 08: Ticket08 is `done`. Exact exam form/generated-group/error completeness, route restore, exam-derived targeted focus, shared assessment/result normalizer and full mobile+desktop offline queue/reconnect flow are closed through public RED→GREEN seams. Affected Grammar/mastery/browser/OpenAPI contour is `90/90`; full unit is `1568` total (`1526` pass + `42` expected PostgreSQL skips, `0` fail). Lint, generated OpenAPI check, check (`382` JS, `211` handlers, `126` names), build (`482` assets, `637.3 KB` shell JS, `9` lazy chunks), dedicated/full/adaptive Chromium E2E, secrets (`1134`), history (`307`), diff-check and fresh authorized audit (`0 vulnerabilities`) are green. Disposable PostgreSQL project `easyboost-postgres-integration-7656` applied migrations `001–052`, passed `42/42`, cleaned container/volume/network, and Docker is stopped. Fresh independent Standards and Spec reviews both returned literal `ZERO_FINDINGS` on canonical identity `52c341453cd4b4f40c3c8fff727f4e31881ac29521f7fc17c22d2c898c2dc0b2` at base `f2fb2ff50d66862685a7061198595457bc1769d9`; the final metadata-only closeout is re-frozen before the sole local commit. The unrelated `.scratch/product-readiness-audit/` remains untouched; no provider/paid calls, package install, push or deploy occurred, and no further Grammar 2.0 ticket will be started.

Ticket08 remediation pre-freeze checkpoint: финальный тикет остаётся `in-progress` на точной базе `f2fb2ff50d66862685a7061198595457bc1769d9` до нового canonical freeze, двух свежих независимых буквальных `ZERO_FINDINGS` на одной identity и единственного локального коммита. Первый Standards/Spec freeze-review нашёл exact-form/generated-group binding, обязательную полноту первых per-topic exam errors, потерю живого `EX` вторым route hook, отсутствие точного exam → targeted focus и неполный desktop/offline-sync E2E. Пять публичных remediation seams дали RED `1/5` → GREEN `5/5`: runtime теперь допускает только одну ordered immutable built-in форму или один generated group позиций 1–6, требует exact first wrong outcome каждой физической темы, сохраняет редактируемый runner после route restore, а server recommendation индексирует built-in exam gaps и выдаёт свежую точную слабость. Следующий Spec review нашёл несовпадающую нормализацию между exam assessment и result UI; точный публичный seam прошёл RED `0/1` → GREEN `1/1`, полный exam contract — `12/12`, и теперь один экспортированный exam normalizer одинаково владеет score, displayed correctness, error bank и Voice Tutor action. Affected Grammar/mastery/browser/OpenAPI контур проходит `90/90`; полный unit — `1568` tests (`1526` pass + `42` штатных PostgreSQL skip, `0` fail). Первый post-doc full при одновременной нагрузке получил известный несвязанный Speaking `service_hung` timing transient; exact isolated seam прошёл `1/1`, затем standalone full suite прошёл `1568/1568` без изменения кода. Lint, generated OpenAPI check, check (`382` JS, `211` inline handlers, `126` names), build (`482` assets, `637.3 КБ` shell JS, `9` lazy chunks), отдельный Grammar, полный последовательный и adaptive Chromium E2E зелёные; Grammar release теперь проходит полные mobile+desktop flows с keyboard, reduced motion, 44px controls, offline edit/reload, durable completion queue, reconnect и ровно одним evidence на физическую тему без horizontal overflow. Финальный disposable PostgreSQL project `easyboost-postgres-integration-7656` применил миграции `001–052`, прошёл `42/42` с exact exam form/group/error atomic/generated persistence/replay/export/delete и полностью удалил container/volume/network; Docker остановлен. Это PostgreSQL evidence остаётся применимым после browser-only normalization remediation, не менявшей validation/repository/persistence. Secrets scan — `1134` tracked files, history scan — `307` commits, diff-check green. С явно разрешённым registry metadata fresh `npm audit --omit=dev --audit-level=high` повторно завершился с `0 vulnerabilities`; manifests после него не менялись. OpenAPI/AI operations/retention/database schema обновлены. Нерелевантный `.scratch/product-readiness-audit/` сохранён; provider/платных вызовов, package install, commit, push и deploy не было.

Final closeout Grammar 2.0 / 07 (supersedes the historical checkpoints below): Ticket07 is `done`. The final affected Grammar/mastery/offline/OpenAPI contour is GREEN `91/91`; compact full unit completed with exit `0` across `1552` tests (`1510` pass + `42` expected PostgreSQL skips). Disposable PostgreSQL project `easyboost-postgres-integration-36912` applied migrations `001–052`, passed `42/42`, and cleaned container/volume/network. Lint, generated OpenAPI check, check (`380 JS`, `208` handlers, `125` names), build (`482` assets, `629.4 KB` shell JS, `9` lazy chunks), full+adaptive Chromium E2E, secrets (`1128`), history (`306`), and diff-check are green. With explicit authorization for npm registry metadata disclosure, fresh `npm audit --omit=dev --audit-level=high` completed with exit `0` and `0 vulnerabilities`; package manifests remained unchanged. Fresh independent Standards and Spec reviews both returned literal `ZERO_FINDINGS` on canonical identity `2f2195e518a99740a7e98258f7c69252ed8cdfe79aee270309c9530df226c9e3` at base `6a7a2488e9ef9ddb5efd8c026ce3151261fc8f4e`. One local commit closes the ticket; Docker is stopped, and no provider/paid calls, package install, push, deploy, or Ticket08 work occurred.

Latest mixed-response identity remediation Grammar 2.0 / 07 (supersedes the historical checkpoints below): status remains `in-progress` until a fresh dependency audit, two fresh independent literal `ZERO_FINDINGS` reviews on one frozen identity, and one local commit. The following Standards review found that the ordinary legacy result-without-topic fallback was still accepted for a mixed event. Exact reconnect RED was `3 total / 2 pass / 1 fail`; it is GREEN `3/3`, and the affected Grammar/mastery/offline/OpenAPI contour is GREEN `91/91`. A topic-less result is now authority only for an ordinary entry without `topicExpectations`; mixed results must name a declared physical topic, otherwise the event remains queued after the existing bounded retry and nothing is broadcast. Compact full unit completed with exit `0` across `1552` tests (`1510` pass + `42` expected PostgreSQL skips). Disposable PostgreSQL project `easyboost-postgres-integration-36912` remains applicable: migrations `001–052`, `42/42`, and complete container/volume/network cleanup; later work changes only browser sync, OpenAPI, tests, and evidence, not server validation or repositories. Lint, generated OpenAPI check, check (`380 JS`, `208` handlers, `125` names), build (`482` assets, `629.4 KB` shell JS, `9` lazy chunks), full+adaptive Chromium E2E, secrets (`1128`), history (`306`), and diff-check are green. Fresh `npm audit` remains blocked by environment policy for external dependency metadata; package manifests are unchanged and Ticket06 audit evidence is not claimed as fresh. Docker is stopped; no provider/paid calls, package install, commit, push, deploy, or Ticket08 work occurred.

Latest fail-closed review remediation Grammar 2.0 / 07 (supersedes both historical checkpoints below): status remains `in-progress` until a fresh dependency audit, two fresh independent literal `ZERO_FINDINGS` reviews on one frozen identity, and one local commit. The next Standards review found one unsafe same-event fallback: a sole response carrying the wrong non-null `topicId` could clear a different queued topic. Its exact reconnect seam produced RED `2 total / 1 pass / 1 fail` and is GREEN `2/2`; the complete affected Grammar/mastery/offline/OpenAPI contour is GREEN `90/90`. Queue authority now requires exact `(eventId, topicId)` or the documented legacy result without `topicId`, and broadcast permits only the queued topic or mixed `topicExpectations`; a mismatched topic remains queued, uses only the existing bounded retry, and is never broadcast. Compact full unit completed with exit `0` across `1551` tests (`1509` pass + `42` expected PostgreSQL skips). Disposable PostgreSQL project `easyboost-postgres-integration-36912` remains applicable: it applied migrations `001–052`, passed `42/42`, and cleaned container, volume, and network; later changes touch only browser sync, OpenAPI, tests, and evidence, not server validation or repositories. Lint, generated OpenAPI check, syntax/inline-handler check (`380 JS`, `208` handlers, `125` names), build (`482` assets, `629.3 KB` shell JS, `9` lazy chunks), full+adaptive Chromium E2E, secrets (`1128`), history (`306`), and diff-check are green. Fresh `npm audit` remains blocked by environment policy for external dependency metadata; package manifests are unchanged and Ticket06 audit evidence is not claimed as fresh. Docker is stopped; no provider/paid calls, package install, commit, push, deploy, or Ticket08 work occurred.

Latest review remediation checkpoint Grammar 2.0 / 07 (supersedes the figures in the historical checkpoint below): the ticket remains `in-progress` until a fresh dependency audit, two fresh independent literal `ZERO_FINDINGS` reviews on one frozen identity, and one local commit. The latest Standards/Spec review found that a reconnected mixed session collapsed all physical topic results by shared `eventId`, and that the batch OpenAPI responses omitted the runtime `X-EasyBoost-Response-Owner` header. Exact public seams produced RED `66 total / 64 pass / 2 fail`; after remediation the affected Grammar/mastery/offline/OpenAPI contour is GREEN `89/89`. Sync now matches queue authority by `(eventId, topicId)`, publishes every authoritative physical topic record exactly once across tabs, and retains a response that cannot be matched safely; both successful batch responses document the owner-binding header. Full unit is `1550 total / 1508 pass / 42` expected PostgreSQL skips / `0 fail`. Disposable PostgreSQL project `easyboost-postgres-integration-36912` remains applicable: it applied migrations `001–052`, passed `42/42`, and cleaned container, volume, and network; later changes touch only browser sync, OpenAPI, tests, and this evidence, not server validation or repositories. Lint, generated OpenAPI check, syntax/inline-handler check (`380 JS`, `208` handlers, `125` names), build (`482` assets, `629.1 KB` shell JS, `9` lazy chunks), full+adaptive Chromium E2E, secrets (`1128`), history (`306`), and diff-check are green. A fresh `npm audit` remains blocked by environment policy for external dependency metadata; package manifests are unchanged and Ticket06 audit evidence is not claimed as fresh. Docker is stopped; no provider/paid calls, package install, commit, push, deploy, or Ticket08 work occurred.

Implementation checkpoint Grammar 2.0 / 07: тикет остаётся `in-progress` до свежего dependency audit, двух независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Mixed runner выбирает `16` current built-in originals — ровно четыре каждого типа, не меньше восьми тем и максимум два задания одной темы — без названия темы и кнопки правила до ответа; ошибка добавляет только exact authored transfer. Его одно завершение атомарно применяется к exact topic expectations: ранняя практика лишь сохраняет историю, due unassisted recall может продвинуть каждую фактическую тему, а поздняя exact ошибка регрессирует только её тему. Targeted runner получает server-owned `grammar-focus-v1` pointer, fail-closed требует минимум `2` exact и `4` error-family items, разрешает ordered `8` current catalog IDs и связывает завершение HMAC receipt с owner/pointer/mastery revision/IDs без повторной сети после авторизации. Adaptive overview/cache/UI показывают exact topic/error/confusion focus и deadline acceleration, не меняя `eligibleAt`; generated history изолирована. OpenAPI исполняемо совпадает с runtime для recommendation receipt, per-topic atomic mastery, balance, bounded transfers и adaptive response. Первый review дал три Spec и одно Standards finding с RED `30 total / 23 pass / 7 fail`; следующий review нашёл reusable receipt и mixed-history multiplication с RED `15 total / 12 pass / 3 fail`. После remediation server и local readers учитывают copied mixed outcome только в фактической теме, а receipt не действует на новой revision; focused-контур проходит `76/76`. Полный unit — `1549 total / 1507 pass / 42` штатных PostgreSQL skip / `0 fail`. Свежий disposable PostgreSQL project `easyboost-postgres-integration-36912` применил миграции `001–052`, прошёл `42/42`, включая обновлённый shared Grammar file/PostgreSQL persistence/export/delete contract, и в `finally` удалил container, volume и network; последующая remediation не меняла validation или repositories, поэтому этот прогон остаётся применим. Lint; generated OpenAPI check; check (`380 JS`, `208` handlers, `125` names); build (`482` assets, `628.8 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1128`; history `306`; diff-check green. Свежий `npm audit` не запускался повторно: внешний запрос dependency metadata отклонён политикой среды; package manifests не менялись и прежний Ticket06 audit не заявляется свежим. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket08 не начинался.

Sixteenth review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет закрыт `done` после двух свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одним локальным коммитом. Пятнадцатый финальный Standards review вернул один P2 finding: generated OpenAPI владел pre-activation ветками, но active catalog×topic branches и active/legacy session catalog unions оставались ручными. Новый публичный generator seam дал exact RED `1 total / 0 pass / 1 fail` из-за отсутствующего модуля, а `openapi:grammar:check` отдельно подтвердил stale schema; после implementation focused-контур прошёл `19/19`. Registry-derived builder теперь генерирует все четыре ownership-зоны; injected synthetic `grammar-core-v4` автоматически появляется в active/legacy unions и только в соответствующих capability branches, а executable `60`-cell runtime×topic matrix плюс обе session schemas подтверждают parity для каждого зарегистрированного каталога. Финальный полный последовательный unit — `1527 total / 1485 pass / 42` штатных PostgreSQL skip / `0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current v3 — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:a26bf36f`; immutable v2 — `584 + 18`, `fnv1a32:86530c23`; immutable v1 — `200 + 18`, `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`376 JS`, `205` handlers, `123` names); build (`482` assets, `614.4 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1124`; history `305`; fresh audit `0 vulnerabilities`; diff-check green. Disposable PostgreSQL project `easyboost-postgres-integration-30680` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые elevated filters пусты. Docker остановлен; provider/платных вызовов, package install, push и deploy не было; Ticket07 не начинался.

Fifteenth review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Четырнадцатый финальный review вернул один P1 Spec и два P2 Standards finding. Catalog×topic OpenAPI matrix прошла RED `16 total / 15 pass / 1 fail` → GREEN `16/16`; два отсутствовавших public seam export дали отдельный module RED `0/2`, затем целевой контур прошёл `82/82`, расширенный Grammar/catalog/domain/mastery/offline/owner/Voice — `128/128`. Один registry-backed runtime владеет exact version+revision, item lookup, legacy membership и active capability; screen restore и server validation больше не повторяют v1/v2/v3 switches, Voice автоматически индексирует все registry revisions, generated OpenAPI допускает v1 для всех девяти pre-activation тем и v2 только для `14/15/19`. Implementation-coupled regex/source-order проверки заменены behavioral pair-ownership и durable pre-render snapshot seams. Финальный полный последовательный unit — `1524 total / 1482 pass / 42` штатных PostgreSQL skip / `0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current v3 — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:a26bf36f`; immutable v2 — `584 + 18`, `fnv1a32:86530c23`; immutable v1 — `200 + 18`, `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `614.4 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1124`; history `305`; fresh audit `0 vulnerabilities`; diff-check green. Disposable PostgreSQL project `easyboost-postgres-integration-9528` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые elevated filters пусты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Fourteenth review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Тринадцатый финальный Standards review вернул один P1 finding; session-bound public seams прошли exact RED `35 total / 33 pass / 2 fail` → GREEN `35/35`, расширенный Grammar/catalog/domain/mastery/offline/owner/Voice контур — `105/105`. Восстановленная active immutable-v2 сессия теперь использует exact v2 topic bank, metadata и item index: wrong answer, transfer, reload, Voice Tutor pointer и completion не подмешивают current v3; сервер проверяет pair ownership через submitted immutable session catalog. Финальный полный последовательный unit — `1521 total / 1479 pass / 42` штатных PostgreSQL skip / `0 fail`. Первый post-production full получил только устаревший source-order assertion (`1478 pass / 1 fail / 42 skip`) и после его точного обновления default-concurrency повторил два известных несвязанных timing transient (`1477 pass / 2 fail / 42 skip`); exact isolated rerun `21/21` и последовательный full зелёные. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current v3 — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:a26bf36f`; immutable v2 — `584 + 18`, `fnv1a32:86530c23`; immutable v1 — `200 + 18`, `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `614.3 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1124`; history `305`; fresh audit `0 vulnerabilities`; diff-check green. Disposable PostgreSQL project `easyboost-postgres-integration-6604` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые elevated filters пусты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Thirteenth review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Двенадцатый финальный Spec review вернул один P1 и три P2 finding; четыре public seam прошли RED `40 total / 36 pass / 4 fail` → GREEN `40/40`, расширенный Grammar/catalog/domain/mastery/offline/owner/Voice контур — `97/97`. Общий Voice registry теперь сохраняет все immutable v2 pointers и создаёт настоящий Voice Tutor attempt из неправильного ответа восстановленной v2-сессии; unknown revision остаётся fail closed. `core.g.19.f.5` принимает `regardless`; explanation `.c.3` говорит о продолжении работы; active-only `.g.14.c.5` учит конкретную convention `the USA` без ложного правила про все multiword countries и без изменения immutable v2. Финальный полный последовательный unit — `1519 total / 1477 pass / 42` штатных PostgreSQL skip / `0 fail`; focused — `97/97`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current v3 — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:a26bf36f`; immutable v2 — `584 + 18`, `fnv1a32:86530c23`; immutable v1 — `200 + 18`, `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `613.9 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1124`; history `305`; fresh audit `0 vulnerabilities`; diff-check green. Предыдущий параллельно нагруженный unit transient `1473 pass / 2 fail / 42 skip` и его зелёные exact reruns остаются в evidence. Disposable PostgreSQL project `easyboost-postgres-integration-3364` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые elevated filters пусты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Twelfth review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Одиннадцатый финальный Spec review вернул два P1 и два P2 finding; exact public seams прошли RED `38 total / 33 pass / 5 fail` → GREEN `38/38`, расширенный affected-контур — `91/91`. Дополнительный factory-bypass seam прошёл RED `6 total / 5 pass / 1 fail` → GREEN `6/6`: caller больше не может произвольно активировать темы. Настоящий pre-Ticket06 каталог сохранён immutable как `grammar-core-v2`/revision `2`, current продвинут до `grammar-core-v3`/revision `3`; общий runner/mastery/persistence/OpenAPI восстанавливает и проверяет точную v1/v2/v3 identity и capability. Исправлены ложная temporal/non-time taxonomy у `core.g.15.c.6` и слишком широкие обещания input prompts `core.g.15.f.2`, `core.g.19.f.3/.5`. Финальный focused контур — `93/93`; полный последовательный unit — `1517 total / 1475 pass / 42` штатных PostgreSQL skip / `0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current v3 — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:2881f68a`; immutable v2 — `584 + 18`, `fnv1a32:86530c23`; immutable v1 — `200 + 18`, `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `613.8 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1124`; history `305`; fresh audit `0 vulnerabilities`; diff-check green. Один предшествующий full unit под одновременной нагрузкой получил два известных несвязанных transient (`http-smoke` readiness и Speaking `service_hung`), `1473 pass / 2 fail / 42 skip`; exact isolated full rerun зелёный. Disposable PostgreSQL projects `easyboost-postgres-integration-39444` и, после усиления shared v2/v3 persistence assertions, `easyboost-postgres-integration-41248` каждый заново применили миграции `001–052`, прошли `42/42` и полностью удалили container/volume/network. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Eleventh review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Десятый финальный Spec review вернул один P1 seam; причина зафиксирована до production-изменений exact RED `35 total / 32 pass / 3 fail` → GREEN `35/35`, дополнительный обычный сезонный вариант `over` — отдельным RED `35 total / 34 pass / 1 fail` → GREEN `35/35`. Time inputs теперь фиксируют точное время, фактическую дату/день события и accountable-for meaning; connector inputs либо буквально привязаны к конечной паре rule-card форм, либо ограничены конкретным типом conjunction/adverb, а их обычные instruction-compliant формы (`whereas`, `whilst`, `yet`, contrast subordinators и `over`) принимаются без раскрытия ответа. Расширенный Grammar/catalog/domain/mastery/offline/owner/Voice контур — `97/97`; полный последовательный unit — `1515 total / 1473 pass / 42` штатных PostgreSQL skip / `0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current catalog — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:c2bac557`, immutable v1 — `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `613.3 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1124`; history `305`; fresh audit `0 vulnerabilities`; diff-check green. Финальный disposable PostgreSQL project `easyboost-postgres-integration-37928` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые elevated filters пусты. Ранее записанные PostgreSQL/Speaking/adaptive transient и их зелёные exact reruns остаются в предыдущих checkpoint и не скрыты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Tenth review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Девятый финальный Spec review вернул два P1 и один P2 finding; все три причины зафиксированы до production-изменений exact RED `67 total / 63 pass / 4 fail` → GREEN `67/67`. Input prompts тем `15` и `19` теперь ограничивают требуемое временное отношение, синтаксическую категорию и структуру, но не печатают принимаемые ответы, поэтому clean input остаётся настоящим active recall; `core.g.15.f.7` буквально фиксирует dependent-preposition reading «pay attention» и исключает duration/search readings; настоящий pre-Ticket06 v2/revision2 legacy snapshot автоматически использует immutable historical content index, отображает исходные prompt/options/answer и сохраняет прежнюю v2 identity, включая `completion_pending`. Расширенный Grammar/catalog/domain/mastery/offline/owner/Voice контур — `96/96`; полный последовательный unit — `1514 total / 1472 pass / 42` штатных PostgreSQL skip / `0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current catalog — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:affdc848`, immutable v1 — `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `613.0 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1124`; history `305`; fresh audit `0 vulnerabilities`; diff-check green. Финальный disposable PostgreSQL project `easyboost-postgres-integration-37548` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые elevated filters пусты. Ранее записанные PostgreSQL/Speaking/adaptive transient и их зелёные exact reruns остаются в предыдущих checkpoint и не скрыты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Ninth review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Девятый Spec review вернул четыре P2 seam; все четыре зафиксированы до production-изменений exact RED `66 total / 62 pass / 4 fail` → GREEN `66/66`, а усиленный сквозной seam для server/OpenAPI identity дал отдельный RED `33 total / 32 pass / 1 fail` → GREEN `33/33`. Concessive choice explanations теперь объясняют именно смысловое отношение, context-bound article/meal задания буквально устраняют неоднозначность, шесть time-preposition inputs публикуют конечные допустимые формы, а восстановленная до активации очередь v1 использует immutable v1 prompt/options/answer и отправляет точную v1 catalog identity через общий runner/server/OpenAPI контракт. Расширенный Grammar/catalog/domain/mastery/offline/owner/Voice контур — `95/95`; полный последовательный unit — `1513 total / 1471 pass / 42` штатных PostgreSQL skip / `0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current catalog — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:7d4ebc25`, immutable v1 — `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `612.5 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1124`; history `305`; fresh audit `0 vulnerabilities`; diff-check green. Финальный disposable PostgreSQL project `easyboost-postgres-integration-28056` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые elevated filters пусты. Ранее записанные PostgreSQL/Speaking/adaptive transient и их зелёные exact reruns остаются в предыдущих checkpoint и не скрыты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Eighth review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Восьмой Spec review вернул четыре P2 content seam; все четыре зафиксированы до production-изменений exact RED `30 total / 26 pass / 4 fail` → GREEN `30/30`. Четыре concessive choices теперь используют только грамматичные phrase/clause distractors с точными relation diagnostics; все восемь connector inputs буквально публикуют конечное множество принимаемых форм; active first-idea choice задаёт listener-new context без изменения v1; две meal corrections образуют exact `zero_article__indefinite_article` transfer pair. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `90/90`; полный последовательный unit — `1508 total / 1466 pass / 42` штатных PostgreSQL skip / `0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current catalog — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:b72dadf8`, immutable v1 — `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `611.8 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1124`; history `305`; отдельный scan двух Ticket06 untracked-файлов; fresh audit `0`; diff-check green. Финальный disposable PostgreSQL project `easyboost-postgres-integration-35336` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые elevated filters пусты. Ранее записанные PostgreSQL/Speaking/adaptive transient и их зелёные exact reruns остаются в предыдущих checkpoint и не скрыты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Seventh review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Седьмой Spec review вернул четыре P2 content seam; все четыре зафиксированы до production-изменений exact RED `26 total / 22 pass / 4 fail` → GREEN `26/26`. Ordinary lunch теперь буквально отделён от scheduled event; fixed-preposition corrections публикуют конечные `in`/`on`; открытые connector prompts принимают `and therefore`/`and yet`; активный v2 cause/result choice больше не использует ошибочно описанный `despite`, сохраняя неизменный v1. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `86/86`; полный последовательный unit — `1504 total / 1462 pass / 42` штатных PostgreSQL skip / `0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current catalog — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:1802160c`, immutable v1 — `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `611.2 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1124`; history `305`; отдельный scan двух Ticket06 untracked-файлов; fresh audit `0`; diff-check green. Финальный disposable PostgreSQL project `easyboost-postgres-integration-24476` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые elevated filters пусты. Ранее записанные PostgreSQL/Speaking/adaptive transient и их зелёные exact reruns остаются в предыдущих checkpoint и не скрыты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Sixth review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Шестой Spec review вернул три P2 content seam; все три зафиксированы до production-изменений exact RED `24 total / 21 pass / 3 fail` → GREEN `24/24`. Последний article input теперь буквально ограничивает первый mention; объяснения year/season соответствуют обоим принимаемым `in` и `during`; активный v2 concessive choice заменил синтаксически неподходящий `despite` на грамматичный wrong-relation `or`, сохранив общий exact transfer и неизменный v1. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `84/84`; полный последовательный unit — `1502 total / 1460 pass / 42` штатных PostgreSQL skip / `0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current catalog — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:7c53f945`, immutable v1 — `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `610.9 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1124`; history `305`; fresh audit `0`; diff-check green. Финальный disposable PostgreSQL project `easyboost-postgres-integration-30516` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые filters пусты. Ранее записанные Speaking/adaptive E2E timing transient и их зелёные exact reruns остаются в предыдущих checkpoint и не скрыты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Fifth review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Пятый Spec review вернул четыре P2 content seam; все четыре зафиксированы до production-изменений exact RED `23 total / 19 pass / 4 fail` → GREEN `23/23`. Два article input теперь буквально ограничивают первый mention и institutional normal purpose, recurring-day choice использует однозначно нетемпоральный distractor, открытые connector prompts принимают `and yet` и `and therefore`, а `SO → BECAUSE` correction принимает обе конечные позиции причины. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `83/83`; полный последовательный unit — `1501 total / 1459 pass / 42` штатных PostgreSQL skip / `0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current catalog — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:d011fa85`, immutable v1 — `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `610.6 КБ`, `9` lazy chunks); full Chromium E2E; secrets `1124`; history `305`; fresh audit `0`; diff-check green. Первый post-doc adaptive E2E один раз не увидел офлайн-прогноз после переключения вкладок (`isVisible: false !== true`); exact rerun без изменений кода прошёл полностью. Финальный disposable PostgreSQL project `easyboost-postgres-integration-30440` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые filters пусты. Ранее записанный Speaking E2E timing transient и его зелёные изолированная/полная перепроверки остаются в предыдущем checkpoint и не скрыты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Fourth review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Четвёртый Spec review вернул два P2 content seam; оба зафиксированы до production-изменений exact RED `19 total / 17 pass / 2 fail` → GREEN `19/19`. Активный v2 Monday-choice больше не предлагает допустимый deadline-вариант `by`, но immutable v1 сохраняет прежнее содержимое; открытые connector prompts принимают конечные грамматичные `while`, `still` и `yet`. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `79/79`; полный последовательный unit — `1497 total / 1455 pass / 42` штатных PostgreSQL skip / `0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current catalog — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:d5892f3f`, immutable v1 — `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `610.3 КБ`, `9` lazy chunks); secrets `1124`; history `305`; fresh audit `0`; diff-check green. Первый full Chromium E2E один раз не начал запись в Speaking task 3; изолированный Speaking сразу прошёл на `375px` и `1440px`, затем полный full E2E и adaptive E2E прошли без изменений кода. Финальный disposable PostgreSQL project `easyboost-postgres-integration-31056` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые filters пусты. Все transient результаты сохранены в evidence и не скрыты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Third review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Третий Spec review вернул три P2 content seam; все три зафиксированы до production-изменений exact RED `17 total / 14 pass / 3 fail` → GREEN `17/17`. Два input теперь принимают конечный грамматичный синоним `during`; December-choice заменил временной `by` на однозначный wrong option `of`, поэтому selected-option weakness снова точен; второй correction cause/result pair теперь действительно тренирует обратное `SO → BECAUSE`, а не clause/phrase ошибку под чужим weakness. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `77/77`; полный последовательный unit — `1495 total / 1453 pass / 42` штатных PostgreSQL skip / `0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current catalog — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:4db8d134`, immutable v1 — `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `610.1 КБ`, `9` lazy chunks); последовательные full+adaptive Chromium E2E; secrets `1124`; history `305`; fresh audit `0`; diff-check green. Финальный disposable PostgreSQL project `easyboost-postgres-integration-24220` заново применил миграции `001–052`, прошёл `42/42`, полностью удалил container/volume/network; независимые filters пусты. Все ранее записанные несвязанные timing transient и их зелёные изолированные/последовательные перепроверки остаются в предыдущем checkpoint и не скрыты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Second review remediation checkpoint Grammar 2.0 / 06 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух новых свежих независимых буквальных `ZERO_FINDINGS` на одной frozen identity и одного локального коммита. Первый Spec review дал три P2 и exact RED `13 total / 10 pass / 3 fail` → GREEN `13/13`; второй Spec review нашёл ещё три P2 content seam и дал новый exact RED `16 total / 13 pass / 3 fail` → GREEN `16/16`. December-choice теперь однозначно задаёт значение «в течение месяца», concessive explanation соответствует noun phrase после `despite`, а controlled `but` transform требует две полные части и публикует принимаемое начало. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `76/76`; полный последовательный unit — `1494 total / 1452 pass / 42` штатных PostgreSQL skip / `0 fail`. Один длинный chained unit-прогон получил несвязанный startup/seed transient Task Bank (`3 !== 6`); `test/task-bank.test.js` сразу прошёл изолированно `10/10`, затем полный suite был зелёным. Ранее один параллельно нагруженный unit-прогон получил прежний Speaking timing failure `service_hung`; он сразу прошёл изолированно `11/11`. Первый post-doc полный прогон с обычной файловой конкуренцией одновременно повторил оба transient (`service_hung` и Task Bank `5 !== 6`), `1450 pass / 2 fail / 42 skip`; изолированные проверки сразу прошли `11/11` и `10/10`, затем полный `--test-concurrency=1` suite прошёл `1494 total / 1452 pass / 42 skip / 0 fail`. Темы `14`, `15`, `19` сохраняют `96` заданий (`32` на тему, `8` каждого типа); current catalog — `665` упражнений + `18` exam gaps = `683` item ID, fingerprint `fnv1a32:4a590236`, immutable v1 — `fnv1a32:45cee292`. Lint; generated OpenAPI check; check (`374 JS`, `205` handlers, `123` names); build (`482` assets, `610.2 КБ`, `9` lazy chunks); последовательные full+adaptive Chromium E2E; secrets `1124`; history `305`; fresh audit `0`; diff-check green. Первый disposable PostgreSQL прогон применил `001–052`, но дал `39/42` из-за трёх прежних exact-boundary Voice Tutor отказов; неизменённый elevated rerun прошёл `42/42`. После первой remediation project `easyboost-postgres-integration-36532` применил `001–052` и прошёл `42/42`; после второй remediation финальный project `easyboost-postgres-integration-34472` снова применил `001–052` и прошёл `42/42`. Все проекты полностью очищены, независимые filters пусты. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было; Ticket07 не начинался. После post-doc gates дерево снова замораживается для двух новых review.

Final v12 review remediation Grammar 2.0 / 05 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. Historical retry-order seam зафиксирован до production как RED `1 total / 0 pass / 1 fail` и закрыт GREEN `1/1`: executable OpenAPI pre-activation envelope повторяет runtime-инвариант по каждому immutable Grammar 1 item — одиночная ошибка запрещена; первая ошибка из двух имеет `transferStatus: null`; правильный повтор остаётся с `null`; второй промах обязан иметь `due_next_session`; misplaced/missing due отклоняются. Positive/negative matrix покрывает `choice` и `input` во всех шести активированных темах, текущие active-схемы не изменены. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `96/96`; текущий v2 fingerprint `fnv1a32:86530c23`, immutable v1 — `fnv1a32:45cee292`. Полный unit suite — `1478 total / 1436 pass / 42` штатных PostgreSQL skip / `0 fail`; последний disposable PostgreSQL project `easyboost-postgres-integration-30360` с миграциями `001–052`, `42/42` и полной cleanup остаётся применимым, потому что после него менялись только OpenAPI и тесты. Lint; generated OpenAPI check; check (`372 JS`, `205` handlers, `123` names); build (`482` assets, `588.2 КБ`, `9` lazy chunks); последовательные full+adaptive Chromium E2E; secrets `1121`; history `304`; audit `0`; diff-check green. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`; Ticket06 не начинался.

Final v11 review remediation Grammar 2.0 / 05 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. Historical OpenAPI weakness seam зафиксирован до production как RED `1 total / 0 pass / 1 fail` и закрыт GREEN `1/1`: queued pre-activation Grammar 1 `choice` принимает только `construction_choice`, а `input` — только `word_or_verb_form`, при exact null diagnostic/confusion и bounded retry общего legacy item. Исполняемая positive/negative matrix покрывает оба типа во всех шести активированных темах, совпадает с runtime и не ослабляет текущие active-схемы. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `96/96`; текущий v2 fingerprint `fnv1a32:86530c23`, immutable v1 — `fnv1a32:45cee292`. Полный unit suite — `1478 total / 1436 pass / 42` штатных PostgreSQL skip / `0 fail`; последний disposable PostgreSQL project `easyboost-postgres-integration-30360` с миграциями `001–052`, `42/42` и полной cleanup остаётся применимым, потому что после него менялись только OpenAPI и тесты. Lint; generated OpenAPI check; check (`372 JS`, `205` handlers, `123` names); build (`482` assets, `588.2 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1121`; history `304`; audit `0`; diff-check green. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`; Ticket06 не начинался.

Final v10 review remediation Grammar 2.0 / 05 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. Prompt/grader correspondence seam зафиксирован до production как RED `1 total / 0 pass / 1 fail` и закрыт GREEN `1/1`: `core.g.10.transform.5` требует буквальную конструкцию `The first box is as heavy as ...`, а accepted set `core.g.10.transform.8` соблюдает опубликованное начало `Team D has` и одно из трёх конечных endings; `weighs as much as` и fronted `Of the four teams` больше не выглядят допустимыми по инструкции и не образуют скрытую ошибку проверки. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `96/96`; текущий v2 fingerprint `fnv1a32:86530c23`, immutable v1 — `fnv1a32:45cee292`. Полный unit suite — `1478 total / 1436 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL project `easyboost-postgres-integration-30360` применил миграции `001–052`, прошёл `42/42`, включая Grammar mastery contract, полностью удалил container/volume/network, независимые elevated filters пусты. Lint; generated OpenAPI check; check (`372 JS`, `205` handlers, `123` names); build (`482` assets, `588.2 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1121`; history `304`; audit `0`; diff-check green. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`; Ticket06 не начинался.

Final v9 review remediation Grammar 2.0 / 05 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. Prompt-constraint seam зафиксирован до production как RED `1 total / 0 pass / 1 fail` и закрыт GREEN `1/1`: три controlled transforms теперь буквально ограничивают конечные автоматически проверяемые структуры вместо открытого множества одинаково правильных парафразов, поэтому неуказанные `the other box`, `of all the hotels` и `of all four teams` больше не выглядят требуемыми ответами и не превращаются в ложные mastery errors. Stale summary fingerprint удалён; прежние значения явно помечены checkpoint-значениями. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `96/96`; v2 fingerprint на том checkpoint — `fnv1a32:a1becaae`, immutable v1 — `fnv1a32:45cee292`. Полный unit suite — `1478 total / 1436 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL project `easyboost-postgres-integration-21992` применил миграции `001–052`, прошёл `42/42`, включая Grammar mastery contract, полностью удалил container/volume/network, независимые elevated filters пусты. Lint; generated OpenAPI check; check (`372 JS`, `205` handlers, `123` names); build (`482` assets, `588.2 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1121`; history `304`; audit `0`; diff-check green. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`; Ticket06 не начинался.

Final v8 review remediation Grammar 2.0 / 05 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. Review seams зафиксированы до production как exact RED `5 total / 0 pass / 5 fail` и закрыты GREEN `5/5`: настоящий browser review для migrated active input публикует current exact weakness, runtime и catalog-generated OpenAPI принимают этот tuple вместе с ограниченным историческим pre-activation fallback, но не разрешают null diagnostic новым active choices. Positive whole-event parity принимает целый active session с linked current independent error; deduplicated branches и exact nullable-string schemas сохраняют взаимоисключающий OpenAPI `oneOf`. Controlled transforms принимают дополнительные конечные грамматичные варианты `Hotel C is the worst of the hotels in the list.`, `The first box is as heavy as the other.` и `Of the four teams, Team D has the least experience.` Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `96/96`; v2 fingerprint на том checkpoint — `fnv1a32:6d5c7ced`, immutable v1 — `fnv1a32:45cee292`. Полный unit suite — `1478 total / 1436 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL project `easyboost-postgres-integration-29868` применил миграции `001–052`, прошёл `42/42`, включая Grammar mastery contract, полностью удалил container/volume/network, независимые elevated filters пусты. Lint; generated OpenAPI check; check (`372 JS`, `205` handlers, `123` names); build (`482` assets, `587.8 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1121`; history `304`; audit `0`; diff-check green. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`; Ticket06 не начинался.

Final v7 review remediation Grammar 2.0 / 05 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. Review seams зафиксированы до production как exact RED `4 total / 0 pass / 4 fail` и закрыты GREEN `6/6`: catalog-generated OpenAPI теперь связывает все `408` active text session tuples с точным item/errorCode/confusionPair вдобавок ко всем `408` selected-option diagnostic tuples, а clean outcomes и исторические pre-activation review fallback представлены отдельными непересекающимися ветвями. Сквозной forged input+linked independentError отклоняется runtime и executable OpenAPI одинаково. Topic 16 больше не полагается на одинаковую singular/plural форму `hurt`: migrated v2 prompts буквально требуют `Both my feet/teeth`, не изменяя immutable v1. Controlled transforms принимают конечные варианты `The first box is as heavy as the second.` и `Team D has the least experience out of the four teams.` Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `95/95`; v2 fingerprint на том checkpoint — `fnv1a32:26e23328`, immutable v1 — `fnv1a32:45cee292`. Полный unit suite — `1477 total / 1435 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL project `easyboost-postgres-integration-35064` применил миграции `001–052`, прошёл `42/42`, включая Grammar mastery contract, полностью удалил container/volume/network, независимые elevated filters пусты. Lint; generated OpenAPI check; check (`372 JS`, `205` handlers, `123` names); build (`482` assets, `587.6 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1121`; history `304`; audit `0`; diff-check green. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`; Ticket06 не начинался.

Final v6 review remediation Grammar 2.0 / 05 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. Review seams зафиксированы до production как exact RED `3 total / 0 pass / 3 fail` и закрыты GREEN `4/4` вместе с positive pre-activation compatibility guard: новый active choice больше не может регрессировать с `diagnosticId: null`, каждый из `408` active diagnostics связан с exact built-in item/errorCode/confusionPair, `independentError` session буквально совпадает с одним wrong outcome, а catalog-generated exact ID whitelist отклоняет вымышленный `core.g.10.c2.1`. Исторические queued Grammar 1 choice/review pointers, text и реальный c2 сохраняют bounded null-diagnostic compatibility. Source-preserving `Hotel C is the worst in the list.` входит в конечные автоматически проверяемые ответы. Воспроизводимая команда `openapi:grammar:check` защищает generated contract от drift. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `93/93`. Темы сохраняют `192` активных задания (`32` на тему, `8` каждого типа), `48` choices и `144` wrong-option diagnostics; v2 на том checkpoint: `584` упражнений + `18` exam gaps, fingerprint `fnv1a32:ec7bd3b3`; immutable v1: `200 + 18`, `fnv1a32:45cee292`. Полный unit suite — `1475 total / 1433 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL project `easyboost-postgres-integration-12672` применил миграции `001–052`, прошёл `42/42`, включая Grammar mastery contract, полностью удалил container/volume/network, независимые elevated filters пусты. Lint; generated OpenAPI check; check (`372 JS`, `205` handlers, `123` names); build (`482` assets, `587.4 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1121`; history `304`; audit `0`; diff-check green. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`; Ticket06 не начинался.

Final review remediation Grammar 2.0 / 05 заменяет предыдущую freeze identity; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. Public TDD начался с `4 total / 1 pass / 3 fail`, controlled-prompt аудит прошёл RED `9 total / 8 pass / 1 fail` → GREEN `9/9`, замечания первого review зафиксированы exact RED `5 total / 0 pass / 5 fail` → GREEN `5/5`, следующий review прошёл RED `4 total / 0 pass / 4 fail` → GREEN `4/4`, cross-topic/source-preserving seam — RED `2 total / 0 pass / 2 fail` → GREEN `2/2`, OpenAPI ownership seam — exact RED `1 total / 0 pass / 1 fail` → GREEN `1/1`, а последний same-topic/legacy-queue seam — exact RED `4 total / 0 pass / 4 fail` → GREEN `4/4`: active diagnostic IDs имеют один whitelist-компонент, а catalog-derived exact ownership связывает каждый item с его конечным множеством selected-option diagnostics в runtime и executable OpenAPI; all-17 matrix покрывает cross-topic и same-topic cross-item подмену в session items и `independentError` для session/review. Active envelope связывает `topicId` со всеми pointers; pre-activation legacy item/review evidence сохраняет исторические null diagnostic и weakness после activation/reload, а post-activation Ticket05 pointers в legacy envelope отклоняются browser/runtime/OpenAPI. Comparison/no-help choice-контексты однозначны; прямые `in the list`, `her bag` и `exactly three hundred` варианты входят в конечные автоматически проверяемые ответы. Chosen wrong-option `errorCode` + `confusionPair` буквально ограничивает generic transfer и forged weakness закрывается `due_next_session`. Расширенный Grammar/catalog/mastery/offline/owner/Voice контур — `135/135`. Темы содержат `192` уникальных активных задания: `32` на тему, `8` каждого типа, `48` choices со `144` exact diagnostics; v2 на том checkpoint: `584` упражнений + `18` exam gaps, fingerprint `fnv1a32:38ed4448`; immutable v1: `200 + 18`, `fnv1a32:45cee292`. Полный unit suite — `1474 total / 1432 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL project `easyboost-postgres-integration-32396` применил миграции `001–052`, прошёл `42/42`, включая Grammar mastery contract, полностью удалил container/volume/network, независимые elevated filters пусты. Lint; check (`371 JS`, `205` handlers, `123` names); build (`482` assets, `587.3 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1121`; history `304`; audit `0`; diff-check green. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`; Ticket06 не начинался.

Final closeout Grammar 2.0 / 04: независимые Standards и Spec review вернули буквальный `ZERO_FINDINGS` на frozen identity base `4baf6b12f068f0d3cf11d2b900de74b3abebaf90`, `18` путей, canonical manifest `1877` bytes, SHA-256 `c3c623390cdf5e8dc21ba0e9af63647fbae118c9ad85669c80b3136bde4266cb`. Тикет закрыт `done` одним локальным коммитом; Docker остановлен, push/deploy/provider-вызовы не выполнялись, Ticket05 не начинался.

Final semantic choice remediation Grammar 2.0 / 04 заменяет предыдущие freeze figures ниже; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. `core.g.9.c.7` снова проверяет буквальный `stop doing`/`stop to do`, но теперь instruction и context независимо требуют purpose, запрещают already-in-progress activity и помещают остановку до первого глотка; target/options/diagnostic taxonomy сохранены. Новый non-tautological gate проверяет эти смысловые ограничения и exact `stop_doing__stop_to_do` diagnostic; TDD прошёл RED `16 total / 14 pass / 2 fail` → GREEN `16/16`. Расширенный контур — `199/199`; полный unit suite — `1455 total / 1413 pass / 42` штатных PostgreSQL skip / `0 fail`; current v2 fingerprint `fnv1a32:4b03208c`, immutable v1 `fnv1a32:45cee292`. Disposable PostgreSQL project `easyboost-postgres-integration-19536` применил миграции `001–052`, прошёл `42/42`, включая Grammar mastery contract, полностью удалил container/volume/network, независимые filters пусты. Lint; check (`369 JS`, `205` handlers, `123` names); build (`482` assets, `546.0 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1119`; history `303`; audit `0`; diff-check green. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`.

Final choice-surface remediation Grammar 2.0 / 04 заменяет предыдущие freeze figures ниже; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. `core.g.9.c.7` теперь однозначно задаёт purpose reading через `pulled over ... then continued the drive`, поэтому прежний distractor `drinking` больше не образует грамматичное competing reading; target/options/diagnostic taxonomy неизменны. TDD прошёл RED `15 total / 14 pass / 1 fail` → GREEN `15/15`; расширенный контур `198/198`; полный unit suite `1454 total / 1412 pass / 42` штатных PostgreSQL skip / `0 fail`; current v2 fingerprint `fnv1a32:6e124dc3`, immutable v1 `fnv1a32:45cee292`. Disposable PostgreSQL project `easyboost-postgres-integration-25276` применил миграции `001–052`, прошёл `42/42`, включая Grammar mastery contract, полностью удалил container/volume/network, независимые filters пусты. Lint; check (`369 JS`, `205` handlers, `123` names); build (`482` assets, `545.9 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1119`; history `303`; audit `0`; diff-check green. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`.

Final finite-equivalent remediation Grammar 2.0 / 04 заменяет предыдущие freeze figures ниже; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. `core.g.9.transform.3` теперь перечисляет обе ограниченные грамматические реализации прекращённой привычки с `stop`: Past Simple и Present Perfect; TDD прошёл RED `15 total / 14 pass / 1 fail` → GREEN `15/15` без semantic matcher и без тематической ветки runner. Расширенный контур прошёл `198/198`, полный unit suite — `1454 total / 1412 pass / 42` штатных PostgreSQL skip / `0 fail`; current v2 fingerprint `fnv1a32:e8ac9e31`, immutable v1 `fnv1a32:45cee292`. Disposable PostgreSQL project `easyboost-postgres-integration-25116` применил миграции `001–052`, прошёл `42/42`, включая Grammar mastery contract, полностью удалил container/volume/network, а независимые filters вернули пустые результаты. Lint; check (`369 JS`, `205` handlers, `123` names); build (`482` assets, `545.9 КБ`, `9` lazy chunks); final full+adaptive Chromium E2E; secrets `1119`; history `303`; audit `0`; diff-check green. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`.

Final OpenAPI envelope remediation Grammar 2.0 / 04 заменяет предыдущие freeze figures ниже; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. Исполняемое связывание `topicId`/source/session envelope прошло RED `1/1 fail` → GREEN `1/1`: built-in сессии всех runtime-active тем требуют exact `topic_practice` 4×4, built-in неактивных тем сохраняют `legacy_practice`, а generated/mixed legacy и review остаются допустимы по тем же правилам, что runtime. Расширенный Grammar/catalog/mastery/offline/owner/Voice/security контур прошёл `198/198`; полный unit suite — `1454 total / 1412 pass / 42` штатных PostgreSQL skip / `0 fail`. Production runtime/catalog после живого PostgreSQL gate не менялись, поэтому применим последний disposable project `easyboost-postgres-integration-128`: миграции `001–052`, `42/42`, полный cleanup container/volume/network и пустые независимые filters. Остальные актуальные доказательства неизменны: `192` задания, fingerprint v2 `fnv1a32:b71d2b54`, v1 `fnv1a32:45cee292`, lint; check (`369 JS`, `205` handlers, `123` names); build (`482` assets, `545.9 КБ`, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1119`; history `303`; audit `0`; diff-check green; Docker остановлен. Provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`.

Final backshift remediation Grammar 2.0 / 04 заменяет предыдущие freeze figures ниже; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. После предыдущих TDD-циклов финальная неоднозначность косвенной речи зафиксирована RED `15 total / 10 pass / 5 fail` и закрыта GREEN `15/15`: все восемь Topic7 input и восемь transform теперь явно задают более поздний пересказ с обязательным backshift, поэтому exact grader не отвергает допустимый retained present без сужающего контекста. Расширенный Grammar/catalog/mastery/offline/owner/Voice/security контур прошёл `197/197`. Шесть тем содержат `192` уникальных активных задания: ровно `32` на тему и `8` каждого из четырёх типов; exhaustive gate проверяет все `192`, `48` choices со всеми `144` wrong-option diagnostics, `72` non-choice semantic pairs, instruction-compliant finite variants и один placeholder каждого input. Current `grammar-core-v2` содержит `452` упражнения + `18` exam gaps с fingerprint `fnv1a32:b71d2b54`; immutable v1 остаётся `200 + 18`, `fnv1a32:45cee292`. Общий Ticket03 runner не получил тематических веток. Полный unit suite — `1453 total / 1411 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL project `easyboost-postgres-integration-128` применил миграции `001–052`, прошёл `42/42`, включая общий Grammar mastery persistence/replay/conflict/export/delete contract, затем полностью удалил container/volume/network, что подтверждено независимыми пустыми post-run filters. Lint; check (`369 JS`, `205` handlers, `123` names); build (`482` assets, `545.9 КБ` shell JS, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1119`; history `303`; production audit `0 vulnerabilities` и `git diff --check` зелёные. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`.

Latest semantic remediation Grammar 2.0 / 04 заменяет предыдущие freeze figures ниже; тикет остаётся `in-progress` до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита. После прежних циклов public RED `4/4 fail`, exact RED `7 total / 4 pass / 3 fail` → GREEN `7/7` и RED `9 total / 5 pass / 4 fail` → GREEN `9/9` последний review-remediation прошёл RED `10 total / 6 pass / 4 fail` → GREEN `10/10`, а дополнительный semantic self-audit — RED `10 total / 7 pass / 3 fail` → GREEN `10/10`; расширенный Grammar/catalog/mastery/offline/owner/Voice/security контур прошёл `192/192`. Темы `5`, `6`, `7`, `8`, `9`, `18` содержат `192` уникальных активных задания: ровно `32` на тему и `8` каждого из четырёх типов. Exhaustive content gate проверяет все `192` задания, `48` choices со всеми `144` wrong-option diagnostics, `72` non-choice semantic pairs, instruction-compliant finite variants и ровно один placeholder каждого input. Current `grammar-core-v2` содержит `452` упражнения + `18` exam gaps с fingerprint `fnv1a32:772c6e86`; immutable v1 остаётся `200 + 18`, `fnv1a32:45cee292`. Общий Ticket03 runner без тематических веток проходит exact answers, per-option taxonomy, paired transfer, bounded due и clean learning/review flow для каждой темы. Полный unit suite — `1448 total / 1406 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL project `easyboost-postgres-integration-13688` применил миграции `001–052`, прошёл `42/42`, включая общий Grammar mastery persistence/replay/conflict/export/delete contract, затем полностью удалил container/volume/network, что подтверждено независимыми пустыми post-run filters. Lint; check (`369 JS`, `205` handlers, `123` names); build (`482` assets, `545.2 КБ` shell JS, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1119`; history `303`; production audit `0 vulnerabilities` и `git diff --check` зелёные. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. После post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS`.

Freeze gate Grammar 2.0 / 04: публичный TDD RED был `4/4 fail`; первый review-remediation прошёл exact RED `7 total / 4 pass / 3 fail` → GREEN `7/7`, а финальный независимый review-remediation — RED `9 total / 5 pass / 4 fail` → GREEN `9/9`; расширенный Grammar/catalog/mastery/offline/owner/Voice/security контур — `191/191`. Темы `5`, `6`, `7`, `8`, `9`, `18` содержат `192` уникальных активных задания: ровно `32` на тему и `8` каждого из четырёх типов. Exhaustive content gate проверяет все `192` задания, `48` choices со всеми `144` wrong-option diagnostics, `72` non-choice semantic pairs, instruction-compliant finite variants и ровно один placeholder каждого input. Current `grammar-core-v2` содержит `452` упражнения + `18` exam gaps с fingerprint `fnv1a32:30024c25`; immutable v1 остаётся `200 + 18`, `fnv1a32:45cee292`. Общий Ticket03 runner без тематических веток проходит exact answers, per-option taxonomy, paired transfer, bounded due и clean learning/review flow для каждой темы. Полный unit suite — `1447 total / 1405 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL project `easyboost-postgres-integration-28324` применил миграции `001–052`, прошёл `42/42`, включая общий Grammar mastery persistence/replay/conflict/export/delete contract, затем полностью удалил container/volume/network, что подтверждено независимыми пустыми post-run filters. Lint; check (`369 JS`, `205` handlers, `123` names); build (`482` assets, `543.8 КБ` shell JS, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1119`; history `303`; production audit `0 vulnerabilities` и `git diff --check` зелёные. Docker остановлен; provider/платных вызовов, package install, commit, push и deploy не было. Ticket04 остаётся `in-progress`; после post-doc gates дерево замораживается до двух свежих независимых буквальных `ZERO_FINDINGS` и одного локального коммита.

Final6 closeout Grammar 2.0 / 03: независимые Standards и Spec review вернули буквальный `ZERO_FINDINGS` на frozen identity base `5b8dd066cfa7a8e0746148bbf032e3bf4b66c316`, 36 путей, canonical manifest 3657 bytes, SHA-256 `eda67bf778ee95fceee5b2072176f2f4bde481a9b3507206f16b35a28c38e8c6`. Тикет закрыт `done` одним локальным коммитом; push/deploy не выполнялись, Ticket04 не начинался.

Final5 review remediation Grammar 2.0 / 03 заменяет предыдущие freeze figures; тикет остаётся `in-progress` до двух новых буквальных `ZERO_FINDINGS` и одного локального коммита. Exact TDD прошёл RED `112 total / 107 pass / 5 fail` → GREEN `112/112`: queue/conflict marker остаётся recoverable, но никогда не считается durable, exact `completion_pending` очищается только по server apply/replay или matching canonical history, а более поздняя same-topic работа блокируется и не может coalesce-удалить исходный UUID/material. Два двусмысленных v2 Past Continuous input prompt теперь буквально требуют action in progress; это единственный content delta, новый v2 fingerprint `fnv1a32:2e59251e`, immutable v1 остаётся `fnv1a32:45cee292`. OpenAPI исполняемо связывает `typeScores.correct/total` с фактическими `session.items` для clean/assisted active и legacy evidence; clean active schema также структурно требует четыре exact `4/4` score. Affected-контур прошёл `120/120`, полный unit — `1437 total / 1395 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL project `easyboost-postgres-integration-18688` применил миграции `001–052`, прошёл `42/42`, затем полностью удалил container/volume/network. Lint; check (`367 JS`, `205` handlers, `123` names); build (`482` assets, `502.6 КБ` shell JS, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1113`; history `302`; production audit `0 vulnerabilities` и `git diff --check` зелёные. Docker остановлен; provider/платных вызовов, install, commit, push и deploy не было.

Final4 review remediation Grammar 2.0 / 03 заменяет предыдущие freeze figures; тикет остаётся `in-progress` до двух новых буквальных `ZERO_FINDINGS` и одного локального коммита. Exact TDD RED `112 total / 107 pass / 5 fail` закрыт GREEN `112/112`. Новый запуск темы и review не перезаписывают `completion_pending`, а восстанавливают и повторяют exact event/UUID/outcomes; stale CAS сохраняет тот же UUID в bounded conflict marker и не создаёт повторную статистику. Exact replay использует canonical `canonical-json-v1` material всего события без FNV replay authority; воспроизведённая runtime-valid пара с одинаковым UUID и старым digest `fnv1a32:34dfbaf5` теперь различается, а file/PostgreSQL отклоняют второй payload как conflict без второй history row. OpenAPI исполняемо запрещает wrong outcomes в unassisted session и связывает built-in `.c/.c2/.f/.correction/.transform` pointer с exact type через структурные ветви, проверенные YAML parser + schema evaluator. Расширенный Grammar-контур прошёл `216/216`, content/property/Voice — `27/27`, полный unit — `1434 total / 1392 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL применил миграции `001–052`, прошёл `42/42`, включая collision replay contract, и полностью удалил container/volume/network. Lint; check (`367 JS`, `205` handlers, `123` names); build (`482` assets, `502.9 КБ` shell JS, `9` lazy chunks); full+adaptive Chromium E2E; secrets `1113`; history `302`; production audit `0 vulnerabilities` и `git diff --check` зелёные. Docker остановлен; catalog fingerprints остаются v2 `fnv1a32:74ce379c`, v1 `fnv1a32:45cee292`. Provider/платных вызовов, install, commit, push и deploy не было.

| Ticket | Результат | Статус |
|---|---|---|
| 01 | Версионированный каталог без потери текущей грамматики | done |
| 02 | Честные стадии освоения и миграция старого прогресса | done |
| 03 | Активный runner и полноценные времена | done |
| 04 | Активный банк глагольных конструкций | done |
| 05 | Активный банк частей речи | done |
| 06 | Активный банк служебных слов | done |
| 07 | Смешанная практика и точный фокус плана | in progress |
| 08 | Экзаменационный режим и release hardening | ready-for-agent |

Подтверждённый объём: все 20 тем, минимум 480 встроенных заданий (не менее шести каждого из четырёх типов на тему), обязательная работа без ИИ, интервалы 1/3/7/16/35 дней, assisted evidence без повышения стадии и точный error focus для индивидуального плана. Реализация начата после явного подтверждения владельца 2026-08-08.

Тикет Grammar 2.0 / 03 остаётся `in-progress`, но финальный freeze gate готов к независимому review. Пять тем времён содержат 160 активных заданий (по 8 каждого из четырёх типов на тему), current `grammar-core-v2` — 310 упражнений + 18 exam gaps с fingerprint `fnv1a32:74ce379c`, immutable v1 — 200 + 18 с `fnv1a32:45cee292`. Runner гарантирует 16/16 уникальных paired transfers, bounded `due_next_session`, per-option диагностику, durable owner-generation-bound `completion_pending` и exact full-event replay/conflict; browser буквально проходит все четыре типа, reload/assisted и отдельную чистую сессию до server-authoritative `learned`. Темы 5–20 сохраняют строгий `legacy_practice`: непустые ordered catalog outcomes, clean partial learning, assisted wrong/no advance, максимум один повтор item со второй ошибкой `due_next_session`, reload/startup exact UUID, replay/conflict и privacy parity без применения active-only 4/type/transfer ограничений. Сгенерированные legacy supplements допускаются только по owner-bound server pointer/revision, всегда assisted и без prompt/answer/reference в mastery; cross-owner/removed source для нового события отклоняется, exact durable replay и changed-payload conflict не зависят от повторного resolve, а write → canonical GET/migrate → unrelated mastery mutation → export сохраняет ID/source/revision/type/outcome без content leakage. Valid builtin, generated `.cN/choice` + `.fN/input` и mixed composition сохраняются idempotently; suffix/type mismatch и четыре source/assisted contradiction удаляют session и не получают replay authority. Mid-session reload для builtin/generated legacy input сохраняет `word_or_verb_form`, revision/assisted provenance и server-valid completion; OpenAPI структурно разделяет builtin/generated/mixed, требует assisted для generated/mixed, связывает `.cN/.fN` с choice/input, исключает incomplete mixed и связывает event/session source/assisted. `core.g.2.transform.1` теперь явно требует Past Continuous background action и фиксированный порядок частей, поэтому естественные альтернативы не отвергаются скрыто. Удаление ровно 13 новых буквальных вариантов из 10 controlled-transform заданий воспроизводит предыдущий v2 fingerprint `fnv1a32:31ae9e4f`, поэтому иной content delta исключён. Literal content/property gate подтвердил 160/160 уникальных prompts, 120/120 choice-диагностик, 80 authored pairs, 240 directed weakness outcomes, 20 480 детерминированных очередей и Voice parity 218 v1 + 328 v2. Последний bounded RED `18/19 → 19/19` закрыл конечные грамматичные варианты порядка обстоятельств без смыслового matcher. Последние RED-циклы `28/33 → 33/33`, `14/16 → 16/16`, `17/21 → 21/21`, `27/29 → 30/30` и `18/20 → 20/20` закрыли normalization provenance, неоднозначные v2 контексты, suffix/type, session composition, reload и полную OpenAPI parity. Freeze evidence: active-runner 19/19, расширенный Grammar-контур 163/163, полный unit 1424 (1382 pass, 42 штатных PostgreSQL skip, 0 fail), финальный live PostgreSQL 42/42 с миграциями 001–052 и active 32 outcomes/16 due/null-pair/duplicate-pair reject/full replay-conflict плюс legacy clean/wrong/due и generated owner/removal/replay/GET-migrate/export-no-content/delete/suffix-type/composition parity. Lint; check (364 JS, 205 handlers, 123 names); build (482 assets, 502.0 КБ shell JS, 9 lazy chunks); full+adaptive E2E; secret scan 1113; history scan 302; production audit 0 vulnerabilities и `git diff --check` зелёные. Временные PostgreSQL container/volume/network удалены, Docker остановлен; provider/платных вызовов, install, commit, push и deploy не было. Дерево заморожено до двух новых буквальных `ZERO_FINDINGS`.

Актуальный remediation checkpoint Grammar 2.0 / 03 заменяет более ранние count-only freeze figures в предыдущем абзаце; тикет остаётся `in-progress` до двух новых буквальных `ZERO_FINDINGS`. Единый browser-safe grammar-domain contract владеет семью error codes, четырьмя active practice types, generated revision/pointer и exact confusion-pair parser; все потребители используют его без локальных enum/regex/revision copies. Device-local `grammarRunner` никогда не уходит через generic progress sync: клиент очищает transport clone, file/PostgreSQL full-save и merge отбрасывают входящий runner и удаляют старую server-копию, а exact owner-generation reload остаётся локальным. Review-remediation TDD RED `62 total / 56 pass / 6 fail` закрыт GREEN `66/66`. Active event требует exact four completed types и matching scores/outcomes; legacy declarations/scores обязаны точно совпасть с фактическим множеством outcome types. OpenAPI требует `16..32` active outcomes и отдельные строгие builtin/generated legacy item branches без active-only metadata, с обязательными generated source/revision. Fingerprint v2 остаётся `fnv1a32:74ce379c`, immutable v1 — `fnv1a32:45cee292`. Расширенный контур прошёл `210/210`, content/property/Voice — `27/27`, полный unit — `1430 total / 1388 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL с миграциями `001–052` прошёл `42/42`, container/volume/network удалены, Docker остановлен. Lint, check (`366 JS`, `205` handlers, `123` names), build (`482` assets, `501.6 КБ` shell JS, `9` lazy chunks), full+adaptive Chromium E2E, secrets `1113`, history `302`, production audit `0 vulnerabilities` и `git diff --check` зелёные. Provider/платных вызовов, install, commit, push и deploy не было.

Final3 review remediation Grammar 2.0 / 03 заменяет предыдущие freeze figures; тикет остаётся `in-progress` до двух новых буквальных `ZERO_FINDINGS` и одного локального коммита. Browser/OpenAPI TDD прошёл exact RED `32 total / 30 pass / 2 fail` → GREEN `32/32`: обычная навигация «К темам» сохраняет недоставленный `completion_pending` с exact event/UUID/outcomes до последующего reload/replay, а OpenAPI разделяет active built-in wrong outcomes на `choice|text × original|transfer` и исполняемо требует non-null `diagnosticId` только у wrong choice, exact `null` у wrong input/correction/transform. Расширенный Grammar-контур повторно прошёл `213/213`, content/property/Voice — `27/27`, полный unit — `1431 total / 1389 pass / 42` штатных PostgreSQL skip / `0 fail`; lint, check (`366 JS`, `205` handlers, `123` names), build (`482` assets, `503.3 КБ` shell JS, `9` lazy chunks), full+adaptive Chromium E2E, secrets `1113`, history `302`, production audit `0 vulnerabilities` и `git diff --check` зелёные. Предыдущий live PostgreSQL с миграциями `001–052` и `42/42` остаётся применимым, потому что после него менялись только browser navigation, OpenAPI и тесты, а server validation/repository path не менялся; Docker остановлен. Fingerprints неизменны: v2 `fnv1a32:74ce379c`, v1 `fnv1a32:45cee292`. Provider/платных вызовов, install, commit, push и deploy не было.

Последний remediation checkpoint Grammar 2.0 / 03 заменяет более ранние числовые figures в предыдущих абзацах; тикет остаётся `in-progress` до двух новых буквальных `ZERO_FINDINGS` и одного локального коммита. Late-error/OpenAPI TDD прошёл exact RED `55 total / 48 pass / 7 fail` → GREEN `55/55`: самостоятельно зафиксированный до раскрытия ответа catalog-bound `independentError` позволяет консервативно понизить уже освоенную тему, но вся session/review после раскрытия остаётся assisted и никогда не продвигает mastery; помощь до ответа, generated content, несовпадающий pointer и произвольный client reason права на регрессию не дают. OpenAPI exact correct/wrong `oneOf`/`allOf` ветви для builtin active и generated active/legacy outcomes теперь совпадают с runtime. Расширенный Grammar-контур прошёл `213/213`, content/property/Voice — `27/27`, полный unit — `1431 total / 1389 pass / 42` штатных PostgreSQL skip / `0 fail`; disposable PostgreSQL project `easyboost-postgres-integration-19004` применил миграции `001–052`, прошёл общий late-error/file/PG contract и весь suite `42/42`, затем полностью удалил container/volume/network, Docker остановлен. Lint, check (`366 JS`, `205` handlers, `123` names), build (`482` assets, `503.3 КБ` shell JS, `9` lazy chunks), full+adaptive Chromium E2E, secrets `1113`, history `302`, production audit `0 vulnerabilities` и `git diff --check` зелёные. Fingerprints неизменны: v2 `fnv1a32:74ce379c`, v1 `fnv1a32:45cee292`. Provider/платных вызовов, install, commit, push и deploy не было.

Ticket Speaking 2.0 / 09 is done. Final independent Standards and Spec reviews both returned
`ZERO_FINDINGS`. The accepted freeze is Final19: 1259 tests total (1218 passed, 41 expected
PostgreSQL skips, 0 failed), disposable PostgreSQL 41/41, lint/check/build, full and adaptive E2E,
secret/history scans and `git diff --check` all green. One local ticket commit follows; push and deploy
remain intentionally pending separate authorization.

# Прогресс — «Говорение 2.0»

Спека: [.scratch/speaking-2-pilot/spec.md](.scratch/speaking-2-pilot/spec.md)
Тикеты: [.scratch/speaking-2-pilot/issues/](.scratch/speaking-2-pilot/issues/)
Ветка: `feature/speaking-2-pilot`

| № | Что даёт | Статус |
|---|---|---|
| 01 | Серверная тренировка задания 1 и банк из 60 текстов | done |
| 02 | Официальное задание 2 из четырёх вопросов и 60 комплектов | done |
| 03 | Интервью задания 3 и 60 комплектов | done |
| 04 | Монолог задания 4 и 60 оригинальных фотопар | done |
| 05 | Полный устный раздел 1+4+5+10=20 | done |
| 06 | Azure Pronunciation adapter и квоты 60/240 минут | done |
| 07 | Детерминированная оценка ФИПИ и методический gate | done |
| 08 | Акцентный профиль, согласия и приватная калибровка | done |
| 09 | Индивидуальный план, Premium-отчёт и Voice Tutor | done |
| 10 | Выпускной аудит и release candidate | done |

Тикет 10 завершён: полный regression прошёл 1 270 тестов (1 229 passed, 41 ожидаемый PostgreSQL
skip, 0 failed), чистый одноразовый PostgreSQL 17 применил миграции 001–052 и прошёл 41/41. Lint,
check (351 JavaScript-файл), frontend build (482 assets), полный Chromium E2E на mobile/desktop,
performance, OpenAPI/parity/security/privacy, secret/history/untracked/audio scans и `git diff --check`
зелёные. Финальные независимые Standards и Spec re-review вернули `ZERO_FINDINGS`. Azure SDK,
тестовый Speech-ресурс, значения секретов и отдельный paid smoke остаются owner-actions; provider-вызовов,
push и deploy не было.

Спецификация и официальное исследование подтверждены владельцем 2026-08-06. Английский контракт
ЕГЭ-2026 закрепляет четыре вопроса задания 2 и максимум 20 баллов; предварительная формулировка про
пять вопросов исправлена до реализации. Платных вызовов, установки Azure SDK, push и deploy не было.

Тикет 09 заморожен для финального review: Base получает полный текущий разбор, безопасную историю и
следующий шаг, Premium — динамику, сравнение, targeted practice и bounded Voice Tutor handoff. Надёжные
Speaking-evidence меняют индивидуальный план, а подсказанные, технические и low-confidence попытки не
повышают mastery. Переход сохранённого плана `ege-en-v1` на `ege-en-v2` явно сбрасывает стабильность.
Targeted practice проверяет фактический Premium и атомарно отклоняет старый указатель после новой
оценки или помощи одинаково в file/PostgreSQL. Финальное укрепление добавило locale-bound цели и
динамику, хронологическую реактивацию после регрессии, `reportRevision` для любой новой оценки, все 11
Speaking micro-activities, bounded Premium mining и evidence-fingerprint CAS после поздней помощи.
Последний review-hardening перенёс entitlement/report/targeted-practice и execution-claim TTL на
post-lock authority time, связал start response с сохранённым fixed-TTL claim и ограничил adaptive
Speaking evidence 120 новейшими попытками до hydration/hash без удаления старых owner-данных.
Проверка: focused 107/107; полный suite 1233 total (1198 pass, 35 штатных PostgreSQL skip, 0 fail),
живой PostgreSQL 35/35 с миграциями 001–052, lint/check, frontend build 482 assets и diff-check —
зелёные. Полный и adaptive Chromium E2E и secret/history scans прошли повторно. Платных/provider-вызовов,
commit, push и deploy не было; дерево передано на свежие последовательные Standards → Spec review.

Тикет 01 закрыт: строгий каталог `speaking-pilot-v1` содержит 60 оригинальных текстов задания 1 с распределением 12/36/12 и автоматическими проверками структуры, уникальности и сходства. Owner-bound API для активной подписки назначает unseen/due/weak/old материал без немедленного повтора, файловое и PostgreSQL-хранилища поддерживают одинаковые безопасные метаданные, экспорт и удаление. Экран проводит mic check, подготовку и запись 90/90 секунд, хранит и проигрывает аудио только локально и честно сообщает об отсутствии фонетического балла без провайдера. Целевые тесты 18/18, frontend build, lint, check и полный `npm test` прошли; независимый Standards/Spec review завершён, все P1/P2 исправлены. Azure SDK, платных/сетевых вызовов, push и deploy не было.

Тикет 07 завершён: сервер сам восстанавливает точное задание и его revision, принимает только финальные owner/session/task/item-bound оценки Azure, а xAI возвращает лишь строгие смысловые и языковые факты. Версионированный детерминированный комбинатор считает официальные максимумы 1/4/5/10 и 20, суммирует языковые и фонетические события для K3, исключает двойные штрафы через owner/span-проверку, проверяет каждую длительность задания 3 и качество записи до платного вызова и не выдаёт ложный ноль при низкой уверенности. Одинаковое оценивание атомарно закрепляется owner-bound fingerprint и воспроизводит один canonical результат без второй попытки или обращения к xAI в file/PostgreSQL; внутренние claim-поля не экспортируются. Пятиминутная аренда и generation fencing безопасно восстанавливают зависший либо временно неудачный xAI-вызов на том же attempt и тех же уже оплаченных Azure facts, а новый provider-bound claim создаётся только после budget/rate admission. Старый adaptive `contentRef + transcript` путь закрыт, а Speaking-блоки временно исключены из composer до owner-bound интеграции в тикете 09. Интерфейс требует новую запись после `needs_retry` и честно перечисляет использованные акустические доказательства. Voice Tutor повторно проверяет сохранённый разбор и отклоняет подменённые или неполные данные. Offline calibration runner воспроизводимо считает согласие экспертов, MAE, within-one, критические ошибки, стабильность и подгруппы; методическая метка остаётся закрыта до двухпроходного отчёта и внешнего подтверждения. Полный suite 1109/1109 (1088 pass, 21 штатный PostgreSQL skip), E2E, frontend build, lint/check, secret scans и отдельный живой PostgreSQL-контур 21/21 прошли; миграции 047–048 проверены вместе с гонкой, fencing, owner isolation, экспортом и удалением. Платных/сетевых вызовов провайдеров, установки SDK, push и deploy не было.

Исторический checkpoint до финального review: готов owner-bound профиль en-GB/en-US с
append-only историей и snapshot новых Speaking-сессий; одноразовый «не знаю» сравнивает одну запись
в двух нормах и сохраняет одну серверную рекомендацию. Отдельное добровольное consent с guardian gate
не влияет на обучение; явная отправка создаёт слепую очередь без имени/VK ID, с одной 15-минутной
review-claim на раунд, двумя независимыми оценками и третьей adjudication при существенном расхождении.
Raw audio действительно удаляется после согласованных оценок/adjudication, отзыва или 180 дней;
экспорт/удаление и file/PostgreSQL имеют один контракт. Целевой контур 16/16, полный suite 1126
(1104 pass, 22 штатных skip), полный Chromium E2E, lint/check, frontend build, secret/history scan,
`git diff --check` и живой PostgreSQL 22/22 прошли. Остались два независимых review, нулевые re-review,
финальный gate и единственный локальный commit; push/deploy/платных вызовов не было.

Тикет 08 завершён: owner-bound акцентный профиль, одноразовый dual-accent setup, отдельное
добровольное calibration consent, guardian gate, слепая экспертная очередь, exact retention,
export/delete и file/PostgreSQL parity доведены до production-контура. Финальное укрепление сохраняет
server-owned task/rubric snapshots для архивных каталогов, не допускает stale accent snapshot в гонке,
делает ручной выбор и setup взаимоисключающими, удаляет все reviewer identities и не позволяет активной
аренде пересечь 180-дневную границу или 25 занятым строкам скрыть следующую доступную. Финальные gates:
accent/API/file 18/18, operations/docs 3/3, `npm test` 1134 total (1111 pass, 23 штатных PostgreSQL skip,
0 fail), полный Chromium E2E, lint/check, frontend build, secret/history scans и `git diff --check`.
Disposable PostgreSQL применила миграции 001–049 и прошла 23/23 с последующей очисткой ресурсов.
Standards и Spec re-review независимо вернули `ZERO_FINDINGS`. Платных/provider-вызовов, установки SDK,
push и deploy не было; тикет закрыт одним локальным commit.

---

# Прогресс — «Чтение 2.0», 60 оригинальных комплектов ЕГЭ-2026

Спека: [.scratch/reading-2-pilot/spec.md](.scratch/reading-2-pilot/spec.md)
Официальная сверка: [.scratch/reading-2-pilot/official-format-research.md](.scratch/reading-2-pilot/official-format-research.md)
Тикеты: [.scratch/reading-2-pilot/issues/](.scratch/reading-2-pilot/issues/)
Ветка: `feature/reading-2-pilot`

| № | Что даёт | Статус |
|---|---|---|
| 01 | Удалённый демо-режим и честный активный доступ | done |
| 02 | Глубокий доменный контракт Reading, история и умная ротация | done |
| 03 | 20 оригинальных комплектов задания 10 | done |
| 04 | 20 оригинальных комплектов задания 11 | done |
| 05 | 20 оригинальных комплектов заданий 12–18 | done |
| 06 | Три тренировки и полный раздел 10–18 | done |
| 07 | Связь со словами, Voice context и индивидуальным планом | done |
| 08 | Premium-отчёт, entitlement-gate и финальное укрепление | done |

Тикет 01 завершён: клиентский учебный демо-вход и все его ветви хранения/ИИ удалены. Учебная
оболочка открывается только после серверного подтверждения активной подписки; при восстановлении
сессии это подтверждение приходит от `/api/v1/me` с `active: true`. Отсутствующая сессия,
неактивная подписка и невозможность проверить доступ по сети имеют разные
экраны. Локальный снимок прогресса не считается разрешением. Chromium E2E используют активную
подписку, подтверждённую сервером, а не клиентский обход.

Тикет 02 завершён: единый Reading API валидирует `reading-pilot-v1`, адаптирует старый fallback
только в техническую тренировку без записи прогресса, хранит owner-bound историю и ограниченный
ledger сдач, детерминированно выбирает unseen/due/weak/old комплекты без мгновенного повтора и
восстанавливает полную попытку только при совпадении catalog/set revisions. Официальный балл
считается по шкале 3/2/7 (максимум 12), диагностические поля остаются 7/6/7 (максимум 20), а
gist/detail evidence сохраняют фактическое время и ссылки на id/revision комплектов.

Тикет 03 завершён: отдельный ленивый shard содержит 20 оригинальных комплектов задания 10 с
распределением 4 B1 / 12 B2 / 4 B2+/C1, двадцатью темами и 140 короткими текстами. Каждый комплект
имеет семь уникальных соответствий, один лишний заголовок, дословные evidence и содержательные
русские объяснения; assembler не публикует каталог, пока все три shard не пройдут общий строгий
валидатор 60/20/20/20. Целевые тесты 53/53, полный suite 883 (868 pass, 15 штатных skip),
lint/check, frontend build и двухосевой review без P0–P2 прошли.

Тикет 05 завершён: отдельный ленивый shard содержит 20 оригинальных длинных текстов заданий
12–18, по семь вопросов и четыре варианта, с распределением 4 B1 / 12 B2 / 4 B2+/C1. Ручной
содержательный аудит охватил все 20 текстов и 140 вопросов: исправлены 21 связь ключа с вариантом,
одна формулировка, четыре русских объяснения и одна недостаточная evidence-цитата. Ключи сохраняют
баланс 35/35/35/35 без повторных и периодических последовательностей. Production-loader и Reading
API публикуют строгий замороженный каталог 60/20/20/20; shards не входят в app shell и после первой
загрузки надёжно доступны из runtime-кэша офлайн. Целевой контур 112/112, полный suite 922
(907 pass, 15 штатных skip), lint/check, frontend build, `git diff --check` и двухосевой review без
оставшихся P0–P3 прошли; push, deploy и переход к тикету 06 не выполнялись.

Тикет 06 завершён: экран Reading работает только с owner-bound каталогом и показывает сводку по
60 комплектам, три тренировки официального размера и полный раздел 10–18 с 20 полями, единым
elapsed timer без автозавершения, автосохранением и совместимым revision-bound восстановлением.
Ключи и evidence скрыты до сдачи; затем доступны официальный результат 3+2+7 = 12, диагностические
7+6+7 = 20 и разбор каждого поля. Недоступный каталог даёт retry и честную техническую тренировку
без официальной шкалы или записи прогресса. Сохранение слов, Voice context и adaptive evidence не
регрессировали. Целевой Reading-контур 145/145 и полный suite 927 (912 pass, 15 штатных skip),
lint/check, frontend build, общий и два Reading Chromium E2E, оба secret scan, `git diff --check` и
двухосевой review без оставшихся P0–P3 прошли; push, deploy и переход к тикету 07 не выполнялись.

Тикет 07 завершён: отдельные Task 10/11/12–18 публикуют точные canonical evidence с set
id/revision/kind/CEFR/contentRef, а восстановленный полный раздел — ровно две согласованные slices
7 gist + 13 detail с общей попыткой и сохранением фактической длительности без двойного учёта.
Адаптивный план запускает точный формат и CEFR и принимает completion только для совпавшего
contentRef; слово сохраняется идемпотентно с проверенным исходным предложением и provenance.
После сдачи сервер восстанавливает Voice context всех 60 комплектов; Base сохраняет полный
текстовый разбор без Voice-кнопок, Premium получает их без передачи ключей/evidence клиентским
payload. Целевой контур 43/43, полный suite 935 (920 pass, 15 штатных skip), lint/check, frontend
build, signed Base/Premium Reading, adaptive, evidence, progress и общий Chromium E2E,
`git diff --check` и двухосевой review без оставшихся P0–P2 прошли; push, deploy и переход к
тикету 08 не выполнялись.

Тикет 08 завершён: один server-owned `reading-report-v1` строит полезный Base и Premium-expanded
проекции только из bounded owner-bound завершённых canonical попыток. Он исключает дубли,
неполный полный раздел, technical/generated/legacy строки, показывает выборку, уверенность,
самостоятельность/поддержку и честные insufficient states. Base по-прежнему получает все 60
комплектов, тренировки, полный раздел и evidence-разбор; свежий server-side entitlement открывает
только Voice и расширение по gist/detail, темам, CEFR, времени и повторным ошибкам. Revoke/expiry,
неактивная подписка и network-unknown различаются без stale Premium-проекции; каждая новая training,
technical, full или adaptive Reading-сессия сначала проходит свежую общую `/me`-проверку, поэтому
статический кэш не становится разрешением. File/PostgreSQL parity
16/16, полный suite 945 (929 pass, 16 штатных skip), целевой контур, lint/check, frontend build,
общий, Vocabulary, Reading Base/Premium/Voice, adaptive, evidence, progress и performance Chromium
E2E, оба secret scan и `git diff --check` прошли. Платных вызовов, push, deploy и production rollout
не было; полный пробник всего ЕГЭ остаётся следующим этапом.

Зафиксирован официальный формат ФИПИ-2026: 7 текстов и 8 заголовков в №10, 6 пропусков и
7 фрагментов в №11, 7 вопросов по 4 варианта в №12–18. В разделе 9 официально учитываемых
заданий и 20 полей ответа; шкала — 3 + 2 + 7 = 12 первичных баллов. Рекомендация ФИПИ
на чтение — 30 минут внутри общих 190 минут письменной части, не отдельный обязательный лимит.
Продуктовая модель владельца: обычная активная подписка получает все 60 комплектов, тренировки,
полный раздел и доказательный разбор; Premium добавляет голосовой разбор и расширенный персональный
отчёт. Демо удаляется полностью. Полный пробник всего ЕГЭ остаётся следующим отдельным этапом.

---

# Прогресс — раннер методической проверки ИИ

Спека: [.scratch/ai-quality-runner/spec.md](.scratch/ai-quality-runner/spec.md)
Тикеты: [.scratch/ai-quality-runner/issues/](.scratch/ai-quality-runner/issues/)
Передача контекста: [.scratch/ai-quality-runner/HANDOFF.md](.scratch/ai-quality-runner/HANDOFF.md)
Ветка: `production-hardening`

| № | Что даёт | Статус |
|---|---|---|
| 01 | Цепочку вызова ИИ можно позвать не только из веб-сервера — раннер бьёт в код приложения | done |
| 02 | Условия 18 работ разобраны в форму, которую принимает промпт | done |
| 03 | Три работы с круговыми диаграммами: опросник для владельца и слияние цифр | done |
| 04 | Отчёт перестаёт выдавать «не измерено» за «не пройдено» | done |
| 05 | Прогон работ через ИИ: прерываемый, возобновляемый, с журналом | done |
| 06 | Журнал прогона превращается в оценки, по которым считаются метрики | done |
| 07 | Три метрики на глаз: опросник для владельца и слияние ответов | done |
| 08 | Записан порядок прогона и то, чего он не закрывает | done |
| 09 | `quality:stubs` сливается с набором, а не переписывает его | done |
| 10 | Модель выбирается ключом `--model`, а причина отказа читается из журнала | done |
| 11 | Отчёт считает по одной модели, а не смешивает прогоны разных | done |
| 12 | Промпт знает допустимые `kind` и три правила ФИПИ, по которым ставится ноль | done |
| 13 | Раннер: `--timeout` для медленной модели и подмножество работ в `--only` | done |
| 14 | Журнал не смешивает версии промпта: правка промпта разводит замеры по файлам | done |
| 15 | Промпт запрещает угловые скобки и считает К1 по аспектной схеме ФИПИ | done |
| 16 | Обрыв связи не считается провалом модели: переспрашивается, а не мерится | done |
| 17 | Версия промпта сохраняется в `aiRuns`, и замеры разных версий не затирают друг друга | done |

Прогон исходных тикетов закончен: восемь исходных выполнены, с девятого по семнадцатый добавлены
сверх них.
Инструмент готов целиком — порядок команд от начала
до конца и честный список того, что этим путём измерить нельзя, записаны в разделе «Порядок
прогона: от условия до отчёта» в [`quality/README.md`](quality/README.md).

**Первый платный прогон состоялся 31 июля 2026 года и не дал ни одного разбора**: все вызовы
отказали с `AI_UNAVAILABLE`, потому что рассуждающая `grok-4.5` отвечает на задание 37 дольше, чем
отведено бюджетом операции. Из этого вырос тикет 10: модель теперь называется ключом прогона, а
причина отказа — таймаут и применённый бюджет — лежит в строке журнала; из него же выросли тикет 12
(промпт поднят до `writing-v3`) и тикет 13 (`--timeout` и подмножество работ в `--only`, чтобы
медленную модель вообще можно было опросить и чтобы сравнение уместилось в остаток на счёте).
Следующий шаг за владельцем:
прогнать набор двумя моделями и выбрать по метрикам раздела 11.2. Пока разборов нет, пункты
раздела 11 ТЗ остаются неразмеченными, а цифра готовности по ТЗ — непересчитанной: закрывают их
цифры прогона, а не наличие инструмента.

Прогон начат 31 июля 2026 года. Тикет 01 закрыт: цепочка вызова провайдера живёт в
`ai/provider-client.js`, `routes/ai.js` её импортирует, и её можно закрепить на одном провайдере
без подмены — это понадобится тикету 05. Тестов стало 272 (271 проходит, 1 пропущен, 0 падают).

Тикет 02 закрыт: `npm run quality:assignments` заполняет `assignmentData` у 18 работ — 12 работ
задания 37 разобраны из строки условия, 6 таблиц задания 38 сняты с текста методичек. Три работы
с круговыми диаграммами остались с `null`: цифр нет в текстовом слое PDF, и подставлять их
«по смыслу» нельзя — их переносит владелец в тикете 03. Тестов стало 277 (276 проходит,
1 пропущен, 0 падают).

Тикет 03 закрыт: `npm run quality:charts` собирает `quality/pie-chart-worksheet.md` — по каждой из
трёх работ методичка, страница, тема проекта, вопрос опроса и пустая таблица «подпись — процент».
Владелец вписывает цифры с диаграммы, `npm run quality:merge-charts` переносит их в
`assignmentData` и снимает тег `assignment-partial`. Проверка при слиянии: 3–8 строк, процент —
целое от 0 до 100, подпись непустая, результат проходит `writingAssignmentSchema`. Сумма процентов
намеренно не проверяется: у ФИПИ есть опросы с несколькими вариантами ответа. Не сошлось — набор
не переписывается вовсе, и скрипт называет работу и строку. Незаполненные работы пропускаются:
опросник можно сдавать по частям. Файл закоммичен пустым — цифры вносит владелец. Тестов стало 288
(287 проходит, 1 пропущен, 0 падают).

Тикет 04 закрыт: три доли §11.2 — `explanationApprovalRate`, `britishEnglishRate`,
`promptInjectionResistance` — считаются только по прогонам, где поле действительно `true` или
`false`. `null` и отсутствующее поле не идут ни в числитель, ни в знаменатель; не измерен ни один
прогон — доля равна `null`, а не нулю. Заодно снята асимметрия: `promptInjectionResistance` считал
отсутствие поля успехом (`!== false`), теперь неизмеренное не приравнивается ни к успеху, ни к
провалу. Гейт не смягчён: неизмеренная метрика пройденной не считается, но `evaluateQualityGate`
возвращает список `unmeasured`, и отказ читается как нехватка данных, а не как провал модели.
Пороги §11.3 не двигались. `npm run quality:check` на `quality/engineering-smoke.json` даёт те же
числа, что и до правки, — там поля проставлены осознанно. Тестов стало 292 (291 проходит,
1 пропущен, 0 падают).

Предупреждение тикета 03 сбылось в тот же день и закрыто вместе с переносом цифр. Счётчики в
`test/quality-writing-assignments.test.js` и `test/quality-pie-charts.test.js` были закреплены на
проходящем состоянии набора и покраснели бы ровно от того, что владелец сделал то, о чём его
просили. Точные равенства заменены на пороги и инварианты, а сверка таблицы с текстом методички
пропускает работы с тегом `assignment-typed` — у диаграммы нет текстового слоя, с которым можно
сверяться, и это факт об источнике, а не дыра в проверке.

Тикет 05 закрыт: `npm run quality:run -- --provider=grok --runs=2` прогоняет набор через ту же
цепочку вызова, что работает у учеников, и пишет журнал `quality/runs/<набор>-<провайдер>.jsonl` —
по строке на вызов, дописанной сразу после ответа. Ключи: `--provider` (обязательный), `--runs`
(2), `--delay` (2000 мс), `--dataset`, `--out`, `--only=<id>`. Имя журнала выводится из набора и
провайдера, а не из времени запуска: повторный запуск той же командой попадает в тот же файл,
пропускает уже сделанные пары «работа + номер прогона» и не платит второй раз. Ctrl+C заканчивает
текущий вызов, дописывает его строку и выходит с кодом 0, назвав остаток. Неудачный вызов
записывается тоже — с кодом ошибки и сырым ответом: доля валидных ответов есть метрика §11.2.
В строке лежит полный разбор ИИ целиком, а не выжимка, — таксономию критических ошибок и проверку
формулировок можно будет вывести из журнала, не оплачивая прогон второй раз.

Ответ ученика нормализуется тем же `writingRequestSchema`, что и в приложении: `trim`,
`sanitizeStudentText`, минимум 20 символов после нормализации. Своей копии правил у раннера нет —
иначе он считал бы слова не по той строке, что `parseAndValidateWritingReview`, и мерил бы не то,
что получают ученики. Работа, не прошедшая нормализацию или без разобранного условия, пропускается
с причиной и прогон не роняет. База данных не участвует: соединение не открывается, в `ai_requests`
ничего не пишется, дневной бюджет учеников не расходуется, и тесты проходят без `DATABASE_URL`.
Настоящий платный прогон не запускался: `.env` на машине нет, ключей нет, и запуск — действие
владельца; в тестах раннер гоняется на подставном `globalThis.fetch`, без сети. Тестов стало 306
(305 проходит, 1 пропущен, 0 падают).

Тикет 06 закрыт: `npm run quality:merge-runs -- quality/runs/<набор>-<провайдер>.jsonl` сворачивает
журнал в поля `aiRuns` — ту форму, которую читает `ai/quality.js`. Отдельным шагом от прогона:
платный журнал не теряется из-за ошибки при записи набора, а изменение эталонного файла видно
в diff.

Суть — сопоставление ключей критериев. ИИ возвращает критерии русскими названиями, набор хранит
оценку эксперта ключами `k1`…`k5` и расшифровку в `human.criteriaLabels`, а `ai/quality.js` сличает
их по имени ключа. Слияние переводит название в тот самый ключ, которым записан эксперт, и падает
при несовпадении, называя работу, номер прогона, критерий и то, с чем его сравнивали. Подобрать
ключ «по порядку» было бы худшим из исходов: отклонение по каждому критерию §11.2 всё равно
посчиталось бы, выглядело бы измерением и было бы неверным. По той же причине слияние отвергает
разбор, где какого-то критерия эксперта нет вовсе, и журнал с нечитаемой строкой: за строкой стоит
оплаченный ответ, и посчитать метрики по неизвестно какой части набора хуже, чем не посчитать их.
Ошибка хотя бы в одной строке оставляет набор нетронутым целиком — половина перенесённого журнала
неотличима на глаз от целого.

Три поля человеческого суждения записываются как `null` — «не измерено»; их ставит владелец по
опроснику тикета 07, и подставленное `true` превратило бы проверку в самообман. `detectedErrors`
записывается пустым списком: разбор возвращает ошибки текстом, а не кодами, таксономии критических
ошибок в проекте нет, и полный текст остаётся в журнале — коды выведутся без нового прогона. Пять
работ с тегом `total-only` сливаются без поля `criteria`: разбивки эксперта у них нет, и
сопоставлять не с чем. Неудачный вызов доезжает до набора отказом — доля валидных ответов есть
метрика §11.2, и молча выброшенный провал её подделывает. Повторное слияние того же журнала не
удваивает `aiRuns` и не переставляет их: прогон опознаётся парой «провайдер + модель», и его записи
заменяются на своих местах, а прогоны другого провайдера остаются нетронутыми.

Заодно снят баг в команде: `quality:check` держал `quality/engineering-smoke.json` прямо в строке
скрипта, и `npm run quality:check <любой другой набор>` молча печатал метрики инженерной заглушки.
Путь убран — `scripts/ai-quality-report.js` подставляет то же значение по умолчанию сам, так что
голый `npm run quality:check` (в том числе в CI) работает как прежде, а имя набора наконец доходит.

Проверено на копии набора в временном каталоге: раннер на подставном провайдере дал журнал из 42
строк по всем 21 работе, слияние перенесло их, и `npm run quality:check <копия>` напечатал метрики
с `criterionMae` по ключам `k1`…`k5` вместо жалобы на пустой `aiRuns`. Сами цифры ничего не значат
— их выдумал подставной провайдер; значение имеет то, что метрики считаются. Настоящий платный
прогон по-прежнему не запускался. Тестов стало 322 (321 проходит, 1 пропущен, 0 падают).

Тикет 07 закрыт: `npm run quality:worksheet-review -- quality/runs/<файл>.jsonl` собирает
`quality/review-worksheet.md` — по каждому прогону идентификатор работы и номер прогона, провайдер и
модель, условие задания, ответ ученика целиком, оценка эксперта по критериям, оценка ИИ по
критериям, его вердикт, главный совет и все разобранные ошибки с фрагментом, исправлением и
пояснением. Судить можно, не открывая ни методичку, ни журнал: журнал — платный `.jsonl` полных
разборов, и читать его владельцу не работа. Три вопроса на прогон — объяснение методически верно,
британский английский выдержан, инструкция из текста ученика не выполнена, — каждый `да` / `нет` /
`не знаю`. `npm run quality:merge-review` вливает ответы в `aiRuns`: `да` → `true`, `нет` → `false`,
`не знаю` → `null`.

Незаполненный пункт не трогается вовсе — он остаётся тем, чем был, то есть `null` после слияния
журнала. Это и есть прямой запрет тикета: пустая галочка означает «не измерено», а не `true`, и
подставленное `true` превратило бы методическую проверку в самообман. Опросник поэтому сдаётся по
частям, а повторное слияние ничего не портит: пересобранный лист приезжает с уже вписанными
ответами, и второй прогон слияния не меняет набор ни на байт.

Прогон опознаётся так же, как в `scripts/merge-quality-runs.js`, — парой «провайдер + модель» и
порядком внутри пары; `runKey` импортируется оттуда, а не переписывается заново, и тест сверяет
метку каждого блока с записью, которую туда положило настоящее слияние журнала. Второй способ
сопоставления однажды разошёлся бы с первым, и разошёлся бы молча. Не сошлось — падение с именем
работы и номером прогона, набор не переписывается вовсе. Отказ провайдера попадает в лист
справочно, без вопросов: разбора в нём нет, а нумерация должна совпадать с набором.

Автоматической проверки британского английского списком американизмов нет намеренно: решение
владельца — ручной проход целиком, потому что список ловит не всё, а полумера, выглядящая как
измерение, здесь дороже пользы. Третий вопрос снабжён оговоркой прямо в шапке опросника: в наборе
ФИПИ работ со спрятанной инструкцией нет и быть не может, честный ответ по ним — «не знаю», и
метрика §11.2 останется неизмеренной. Это правильнее выдуманной единицы; измерить её можно будет
только отдельным набором работ с внедрённой инструкцией внутри.

Сам `quality/review-worksheet.md` не коммитится и добавлен в `.gitignore` рядом с журналами
прогонов: он собирается из журнала, до платного прогона его не существует, а подделывать его
нельзя — ответы владельца приезжают в набор слиянием. Проверено на копии набора во временном
каталоге: подставной журнал из 4 строк по двум настоящим работам, опросник собран, два прогона
заполнены руками, слияние записало `true`/`false`/`null` по ответам, а `calculateQualityMetrics`
дал `explanationApprovalRate` 0.5, `britishEnglishRate` 1 и `promptInjectionResistance` `null` —
«не знаю» оставляет метрику неизмеренной. Настоящий платный прогон по-прежнему не запускался.
Тестов стало 336 (335 проходит, 1 пропущен, 0 падают).

Тикет 08 закрыт: раздел «Порядок прогона: от условия до отчёта» в
[`quality/README.md`](quality/README.md) описывает весь путь по шагам — какая команда что делает,
где оседает её результат и что нужно от владельца между шагами. По нему можно пройти, ни разу не
заглянув в спеку и не открыв ни одного скрипта: провайдеры названы именами переменных окружения
(`XAI_ENABLED`, `XAI_API_KEY`, `GROQ_ENABLED`, `GROQ_API_KEY`) без единого значения, ключи команды
`quality:run` сведены в таблицу, а поля отчёта расшифрованы словами. Отдельно сказано, что
`quality:check` до слияния журнала отказывает с `scores are incomplete` — это ожидаемое состояние
пустого `aiRuns`, а не поломка.

Половина раздела — про то, чего прогон **не** закрывает: объём набора (нужно 20 и 30 работ, есть
12 и 9, и `--release` откажет по объёму — это правильно); полноту обнаружения критических ошибок,
которая остаётся `null`, пока `expectedCriticalErrors` пуст у всех работ и таксономии кодов в
проекте нет; три метрики человеческого суждения, измеренные ровно настолько, насколько пройден
опросник, — неизмеренное показывается как `null` и в `gate.unmeasured`, а не как ноль; и устную
часть, не охваченную вовсе. Там же записано, почему пункты раздела 11 ТЗ этими командами не
закрываются: раннер — инструмент, а §11.2 закрывают цифры настоящего прогона, и делает его
владелец. Пункты ТЗ не размечены и цифра готовности не пересчитана намеренно.

Заодно в `quality/README.md` поправлены счётчики, устаревшие с коммита `6791b90`: набор — 12 работ
задания 37, а не 13, и 21 уникальная работа, а не 22; до минимума §11.1 не хватает 8 работ задания
37, а не 7. Соседний абзац этого же файла теперь говорит «20 и 30 против 12 и 9», и старые числа
противоречили бы ему на одной странице. Строка про раннер добавлена в `AGENTS.md`: до неё каталог
`quality/` описывался только как набор данных, хотя половина команд `npm run quality:*` — это уже
инструмент прогона. Тестов по-прежнему 336 (335 проходит, 1 пропущен, 0 падают): тикет
документационный, кода он не трогает.

Тикет 09 закрыт: `npm run quality:stubs` сливается с `quality/writing-fipi-stubs.json` по `id`, а не
пишет набор поверх одним `fs.writeFile`. Перезапись была верна ровно один раз — когда файла не
существовало и скрипт его создавал. С тех пор в набор легло то, чего в методичках нет и быть не
может: тексты 21 работы, набранные владельцем с рукописных сканов, разобранные условия, проценты
трёх круговых диаграмм, прочитанные глазами с картинки, и скоро — оплаченные прогоны ИИ. Один
запуск старой команды снёс бы всё это разом, а восстановить нечем: сканы рукописные, прогоны
платные.

Запретить запуск поверх непустого файла было бы проще и хуже: §11.1 требует 20 работ задания 37 и
30 задания 38, есть 12 и 9, и методичка ФИПИ за 2022 год — записанный путь пополнения; пополнять
набор командой, умеющей только «создать с нуля», нельзя. Поэтому не трогаются вовсе `answer`,
`assignmentData`, `aiRuns`, `expectedCriticalErrors` и состояние тегов, отражающее ручную работу
(`assignment-typed` остаётся, снятый `needs-answer-text` не возвращается, `assignment-partial` не
приезжает к работе с уже перенесённой диаграммой). Обновляются `assignment`, `human`, `source` и
выведенные из PDF теги — и каждое расхождение печатается: работа, поле, было → стало, с окном по
первому несовпавшему символу, потому что условие работы — абзац и обрезка с начала показала бы у
обеих сторон одно и то же. Молчаливая пересборка эталонного набора необъяснима, а объяснимая —
проверяема.

Работа, которой в пересборке нет, остаётся в наборе и называется в сводке. Это прямое следствие
того, что разрыв в 21 работу задания 38 закрывается живой оценкой преподавателя: таких работ нет
ни в одной методичке, и «нет в пересборке» для них — норма, а не повод удалить. Регрессия разбора
выглядит точно так же, и оба случая хуже потерять, чем сохранить лишнее. Порядок существующих
записей сохраняется, новые дописываются в конец: набор правят руками, и перестановка строк в diff
означала бы правку там, где её нет. Файл не переписывается, если сливать нечего, — повторный
запуск на нынешнем наборе даёт «сохранено нетронутыми: 21» и не трогает файл ни на байт. Флага
`--force` нет намеренно: `git checkout -- quality/writing-fipi-stubs.json` возвращает файл точнее.

Проверено на копии скрипта и методичек во временном каталоге: в копию набора подложены выброшенная
работа, искажённое условие, стёртый объём, снятый тег и работа преподавателя, которой нет ни в
одной методичке, — слияние добавило одну, обновило три с распечаткой расхождений, оставило 17
нетронутыми, сохранило работу преподавателя вместе с её `answer` и `aiRuns` и назвало её в сводке;
второй запуск подряд не изменил ничего. Первый запуск на отсутствующем файле даёт файл байт в байт
такой же, как скрипт до правки. Сам `quality/writing-fipi-stubs.json` в этом тикете не менялся:
тикет меняет способ записи, а не данные. Тестов стало 340 (339 проходит, 1 пропущен, 0 падают).

Тикет 11 закрыт: `npm run quality:check -- <набор> --model=<id>` и `--provider=<имя>` считают метрики
только по прогонам, совпавшим с фильтром. Это понадобилось ровно потому, что владелец сравнивает две
модели: слияние кладёт прогоны обеих в один набор и правильно их различает, а `calculateQualityMetrics`
считал по всем записям сразу. У работы с четырьмя прогонами — двумя от одной модели и двумя от другой
— среднее отклонение усреднялось по обеим, а `stabilityWithinOnePoint` брала разброс баллов внутри
работы и называла расхождение **между разными моделями** нестабильностью одной. Смешанные метрики
выглядят как измерение и измерением не являются, а решение о продукте принимают по ним.

Выбранный фильтр печатается полем `filter` рядом с именем набора: по чему считали, должно быть видно
в самом отчёте, а не только в истории команд. Работа, у которой под фильтром не осталось ни одного
прогона, называется поимённо — полем `casesWithoutRuns` и строкой на stderr: набор, измеренный
наполовину, не то же самое, что измеренный целиком. Названная модель, которой в наборе нет вовсе
(опечатка в ключе), останавливает команду и перечисляет те, что есть: отчёт из сплошных `null`
выглядел бы отчётом. Форма `--model grok-4.3` без знака равенства отвергается — значение уехало бы в
позиционный аргумент и стало бы именем набора.

Главное — предупреждение. Если в отбор попали прогоны больше чем одной пары «провайдер + модель»,
команда печатает рамку из `#` на stderr и повторяет предупреждение полем `warning` в самом отчёте,
называя обе модели и готовые команды по каждой. Считается это по тому, что осталось после отбора, а
не по набору: `--provider=grok` при двух моделях одного провайдера смешивает их ровно так же, как
отсутствие ключей вовсе. Молча смешать — единственный по-настоящему опасный исход.

Формулы метрик и пороги §11.3 не двигались: тикет меняет, по какому подмножеству считать, а не как.
Отбор живёт в `ai/quality.js` рядом с формулами (`filterQualityRuns`, `listRunVariants`) и опознаёт
прогон той же парой «провайдер + модель», что и слияние журналов; записи без этих полей образуют
собственную пару и ни с какой названной моделью не совпадают — «неизвестно чей прогон» и «прогон этой
модели» разные вещи. Набор при отборе копируется, а не правится. Без ключей вывод не изменился ни на
символ: `npm run quality:check` на `quality/engineering-smoke.json` — где полей `provider` и `model`
нет вовсе — даёт байт в байт тот же JSON, что и до правки; тест закрепляет состав и порядок ключей
отчёта, а не числа. Проверено на фикстуре из двух моделей во временном каталоге: без фильтра
`stabilityWithinOnePoint` 0.33, с `--model=` — 1 по той же работе. Тестов стало 354 (353 проходит,
1 пропущен, 0 падают).

Тикет 12 закрыт: промпт письменной части поднят до `writing-v3` и закрывает два пробела, которые
вскрыл первый платный замер 31 июля 2026 года (`quality/writing-fipi-stubs.json`, коммит `15a95f3`).

Первый — перечень `kind`. Схема разрешает `err` и `warn`, промпт показывал один пример и не называл
множество; модель тянулась к третьему значению `miss` — «пункт плана пропущен» — и разбор
отвергался. Это причина **всех** отказов схемы: 17 из 17 у `grok-4.20-non-reasoning` и 2 из 2 у
`grok-4.3`, причём попытка восстановления формата пропадала впустую — на повторе модель писала то
же самое. Теперь промпт называет оба значения, говорит, чем они отличаются, и явно указывает, куда
девать невыполненный пункт плана, неотвеченный вопрос и нарушение объёма (`kind: "err"`).

Второй — правила ФИПИ, по которым выставляется ноль. На четырёх работах, где эксперт поставил 0, ИИ
поставил от 2 до 5; среднее отклонение на них 3,00 против 1,26 на всех остальных. Правил в промпте
не было ни одного. Добавлены три, дословно по `quality/sources/fipi-pch-2026.txt`: ноль по критерию
«Решение коммуникативной задачи» обнуляет всё задание; меньше 90 слов в задании 37 и 180 в задании
38 — задание проверке не подлежит; больше 154 и 275 слов — оценивается только первые 140 и 250 слов
ответа. Числа не вписаны константами, а выводятся из `TASK_RULES` — 90 % от нижней границы и 110 %
от верхней, — и название обнуляющего критерия берётся оттуда же: второй набор констант разошёлся бы
с первой же правкой правил, и промпт начал бы сообщать модели то, чего сервер не держит. Тест
сверяет числа обоих заданий с `getWritingRules` и отдельно проверяет, что `154` и `275` не
встречаются в исходнике вовсе.

Серверного принуждения этих правил тикет намеренно не добавляет: `parseAndValidateWritingReview`,
`writingReviewSchema` и список допустимых `kind` не тронуты. Контракт прежний — меняется только то,
что о нём знает модель. Если правила будут нарушаться и дальше, это станет видно в метриках
следующего замера, и принуждение станет решением с цифрами на руках. Версия промпта — часть
контракта: по ней в `ai_requests` различают, каким промптом получен ответ, и старый замер на
`writing-v2` не смешивается с новым. Из-за неё правились ровно две строки в существующих тестах
(`test/writing-facts.test.js`, `test/ai-format-repair.test.js`) — только сама строка версии, с
причиной в комментарии рядом; ассерты и пороги не двигались. Прогон не запускался: замер — действие
владельца. Тестов стало 357 (356 проходит, 1 пропущен, 0 падают).

Тикет 13 закрыт: у раннера появились ключ `--timeout=<мс>` и список работ в `--only`. Оба выросли
из одного — владелец сравнивает `grok-4.3` и `grok-4.5` на исправленном промпте, и ни то ни другое
раньше было невозможно. `grok-4.5` отвечает на задание 37 около 118 секунд при бюджете операции 45,
поэтому 31 июля 2026 года все её вызовы отсеклись по таймауту и ни одного разбора не получилось; а
полный её прогон — около $15 при остатке порядка $5, так что сравнивать приходится на подмножестве,
и «одна работа или все 21» такого выбора не давало.

Ключ действует только на процесс раннера: `createProviderClient({ timeoutMs })` подменяет
`timeoutMs` для вызовов **этого клиента**, а `ai/operations.js` и `config.js` не тронуты вовсе —
приложение по-прежнему берёт бюджет из реестра, зажатый `config.ai.maxTimeoutMs`. Тот бюджет
остался читаемым отдельным именем `appLimitsFor`, и именно он нужен для главного в этом тикете.

Главное — предупреждение. Раннер существует, чтобы мерить то, что получают ученики, и поднятый
таймаут это нарушает: модель, которой дали 180 секунд, — не та модель, что стоит за кнопкой с
бюджетом 45. Поэтому, когда названное время превышает бюджет операций прогона, шапка печатает рамку
из `#` со словами «измеряется модель за пределами того, что ей отведено в приложении», называет
превышенные бюджеты пооперационно и говорит, что вопрос «ждёт ли ученик две минуты» решается
поднятием бюджета в `ai/operations.js` — решением владельца, а не ключом раннера. Итоговая сводка
повторяет применённый таймаут: цифры не должны уехать из-под условия, при котором получены.
Применённое значение уходит и в `failure.timeoutMs` журнала — поле тикета 10 теперь пишет то, что
к вызову действительно применялось. Отдельный тест проверяет, что число доходит до
`AbortController`, а не только до отчёта: заглушка не отвечает никогда, и вызов обрывается по
ключу, а не по бюджету операции — иначе шапка утверждала бы одно, а журнал отражал бы другое.

Список в `--only` — множество, поэтому повтор идентификатора не оплачивается дважды, а порядок
остаётся порядком набора: подмножество читается как часть полного прогона. Опечатка в любом имени
останавливает прогон и называет ненайденные работы поимённо: молча уменьшившееся подмножество
превратило бы сравнение двух моделей в сравнение на разных наборах работ. `--runs` при этом не
трогается — §11.3 сравнивает повторы внутри работы, и экономия на прогонах вместо работ лишила бы
отчёт `stabilityWithinOnePoint` целиком.

Прогон не запускался: замер платный и остаётся действием владельца. Тестов стало 364 (363 проходит,
1 пропущен, 0 падают).

Тикет 14 закрыт: защита журнала от чужой модели (тикет 10) распространена на версию промпта. Тикет
12 поднял `WRITING_PROMPT_VERSION` с `writing-v2` на `writing-v3`, а в
`quality/runs/writing-fipi-stubs-grok-grok-4.3.jsonl` лежали все 42 пары «работа + прогон» от
замера на старом промпте. Возобновление опознаёт пару «работа + номер прогона», версия промпта в
неё не входит, поэтому та же команда не сделала бы **ни одного вызова**, отчиталась бы «всё
сделано», и метрики старого промпта были бы прочитаны как проверка новой правки — тихая подделка
ровно того замера, ради которого правка делалась. Обойти это можно было ключом `--out`, но защита,
которая работает только пока о ней помнят, защитой не является — а помнить пришлось бы ровно в тот
момент, когда результату особенно хотят верить.

Сделано тем же приёмом, что и для модели, а не вторым: версия промпта входит в имя журнала по
умолчанию (`quality/runs/writing-fipi-stubs-grok-grok-4.3-writing-v3.jsonl`), поэтому правка
промпта разводит замеры по файлам сама; журнал, в котором лежит другая версия, останавливает прогон
**до первого платного вызова**, называет обе версии — ту, что в журнале, и ту, что в коде — и
предлагает имя нового файла. Строки без `promptVersion` прогон не роняют: их число печатается в
шапке, и текущей версии они не засчитываются — чем они получены, проверить нечем, а приписать их
`writing-v3` значило бы сделать ровно ту подделку, от которой тикет и защищает.

Записанные журналы не тронуты: `writing-fipi-stubs-grok-grok-4.3.jsonl` и
`writing-fipi-stubs-grok-grok-4.20-non-reasoning.jsonl` — замеры промпта `writing-v2`, уже слитые в
набор. `scripts/merge-quality-runs.js` не правился намеренно: он опознаёт прогон парой «провайдер +
модель» и прогоны одной модели на разных промптах сложит в одну кучу. Это записано в
`quality/README.md` как известное ограничение — сначала надо решить, чем такие прогоны считать, а не
закодировать походя. Прогон не запускался: замер платный и остаётся действием владельца. Тестов
стало 366 (365 проходит, 1 пропущен, 0 падают).

Тикет 15 закрыт: промпт поднят до `writing-v4` и закрывает две дыры, оставшиеся после замеров
`grok-4.5` на `writing-v3` (коммиты `b8f1ddd` и `8a94691`).

Первая — регрессия тикета 12. Строка «Больше 154 слов» научила модель писать сравнения знаком:
«(277>275)», «>154», «не majority (>50%)». §10.4 запрещает угловые скобки в текстовых полях разбора
— разметке нечего делать в объяснении для ученика, — и `reviewText` такие ответы отвергал. Это все
четыре отказа `grok-4.5` и её провал по доле валидных ответов: 90,5 % при пороге 95 %. Защита
верная и не тронута; промпт теперь говорит прямо, что угловых скобок в тексте быть не должно, а
сравнения пишутся словами. Тест проверяет и то, что сам промпт не показывает знак, который
запрещает.

Вторая — мягкость к К1. Отклонение `grok-4.5` на семнадцати обычных работах 1,16 при пороге 1, а на
четырёх, где эксперт поставил 0, — 2,67: за 42 прогона ноль по коммуникативной задаче выставлен
дважды. Правило тикета 12 давало модели последствие нуля, но не признак, по которому ноль ставится.
Признак у ФИПИ счётный — аспектная схема, и теперь она в промпте: шесть аспектов у каждого задания,
по одной пометке на аспект («раскрыт / раскрыт неполно, неточно / не раскрыт») и полосы «сколько
пометок — сколько баллов». Аспекты задания 37 (три ответа, три вопроса, вежливость, стиль) взяты из
таблицы 1.9 и дополнительной схемы 1.10, аспекты задания 38 (вступление, факты, сравнения, проблема
с решением, мнение, нейтральный стиль) — из типовой схемы 1.12, всё в
`quality/sources/fipi-pch-2026.txt`.

Шкалы у заданий **разные**, и ни одна не выведена из другой: К1 задания 37 упирается в 2 балла,
задания 38 — в 3. Шкала задания 37 нашлась и подтверждена цитатой: таблица 1.9 при извлечении
перемешивается по колонкам, но колонка РКЗ читается целиком, а её полосы на 2, 1 и 0 баллов
пересказаны прозой в разборах работ в методичках 2023 и 2024 годов слово в слово. Попутно вскрылось,
что цитата нуля, приведённая в тикете как шкала задания 38 («3 и более аспекта содержания
отсутствуют, ИЛИ 6 аспектов раскрыты неполно/неточно…»), — на самом деле шкала задания **37**:
шесть аспектов и максимум 2 балла. У задания 38 ноль сформулирован иначе: «все случаи, не указанные
в оценивании на 1, 2 и 3 балла, ИЛИ ответ не соответствует требуемому объёму, ИЛИ более 30 % ответа
имеет непродуктивный характер». В промпт по каждому заданию положено то, что подтверждено его
собственной цитатой. Номера полос не вписаны литералами, а отсчитаны от максимума К1 в `TASK_RULES`
— по той же причине, что и пороги объёма: литерал пережил бы правку критерия и стал бы сообщать
модели то, чего сервер не держит.

Контракт не менялся: `parseAndValidateWritingReview`, `writingReviewSchema` и `reviewText` не
тронуты. Аспекты — способ рассуждения модели, а не поле ответа; сервер по-прежнему принимает те же
пять полей и те же критерии. Промпт вырос: задание 37 — с 2131 до 3191 знака, задание 38 — с 2198
до 3467; системная часть не изменилась. Из-за версии правились ровно две строки в существующих
тестах (`test/writing-facts.test.js`, `test/ai-format-repair.test.js`) — только сама строка версии,
с причиной в комментарии, — и одно упоминание текущей версии в `quality/README.md`. Прогон не
запускался: замер платный и остаётся действием владельца. Тестов стало 369 (368 проходит,
1 пропущен, 0 падают).

Тикет 16 закрыт: обрыв связи перестал записываться провалом модели. 1 августа 2026 года первый
вызов прогона `grok-4.5` на `writing-v4` отказал `TypeError: fetch failed` за 10,7 с при бюджете
300 с, а через минуту та же связь отвечала за 250–470 мс: ответ до модели не дошёл. Раннер считал
такой обрыв **сделанной парой «работа + номер прогона»** — возобновление её не переспрашивало,
слияние записывало `valid: false`, и `schemaPassRate` считала сетевую икоту провалом модели. Это та
же подмена, которую тикет 04 убрал из метрик человеческого суждения: «не измерено» выдаётся за «не
пройдено», и тиха она тем, что выглядит измерением — одна икота на 42 вызова двигает
`schemaPassRate` на 2,4 % при пороге §11.3 в 95 %.

Делится теперь по природе ошибки, а не по тексту сообщения. `AI_RESPONSE_INVALID_*` — это **данные**:
модель ответила, ответ разобран и отвергнут, доля валидных ответов §11.2 измеряет ровно их. Такая
строка помечена `failureKind: contract`, считается сделанной парой, в набор едет как `valid: false`
и переспрашиванию не подлежит — она оплачена и измерена. `AI_UNAVAILABLE` — обёртка
`runProviderFallback` над ошибкой, из-за которой ответа не было вовсе: оборванное соединение,
отсечка по таймауту, отказ провайдера до модели. Такая строка помечена `failureKind: transport`,
сделанной парой не считается, в `aiRuns` не попадает ни как `valid`, ни как `valid: false`, а
переспрашивает её повторный запуск той же команды. `AI_NOT_CONFIGURED` обработан сильнее прочих и
раньше: прогон падает целиком, ни одной строки не записав.

Признак берётся из `isFormatFailure` — того самого предиката, по которому `ai/provider-client.js`
решает, давать ли попытку починки формата, — и живёт в одном месте на оба скрипта: раннер его
ставит, слияние по нему решает, ехать ли строке в набор. Второе определение «что такое нарушение
контракта» однажды разошлось бы с первым, и разошлось бы молча. Прямое следствие: **журналы,
записанные до появления поля, читаются тем же правилом** — по коду отказа, который раннер туда и
положил. Задним числом переписывать журнал не нужно и нельзя; обрыв в уже записанном журнале
переспросится сам.

Число обрывов называется вслух в трёх местах: в шапке прогона («сделанными парами не считаются и
будут переспрошены»), в его итоге («из них обрывов связи: N») и в сводке слияния («в набор не
перенесены»). Заодно `scripts/build-review-worksheet.js` перестал печатать блок для обрыва: слияние
такую строку в `aiRuns` не кладёт, и блок сдвинул бы порядковый номер каждого следующего прогона —
суждение владельца легло бы на чужую запись, тихо и необратимо.

Формулы метрик и пороги §11.3 не двигались, `runProviderFallback`, коды ошибок и `routes/ai.js` не
тронуты вовсе: меняется не поведение приложения, а то, что раннер считает измерением. Записанные
журналы не правились. Проверено на живом журнале идущего прогона: `readJournal` видит в нём
сделанные пары и **один обрыв к повтору** — руками удалять строку не нужно. Тестов стало 375
(374 проходит, 1 пропущен, 0 падают).

Тикет 17 закрыт: `promptVersion` доезжает из каждой измеренной строки журнала в `aiRuns`, а
`runKey` теперь опознаёт источник тройкой «провайдер + модель + версия промпта». Красный тест
воспроизводил точную поломку двумя последовательными слияниями: после `writing-v3`, затем
`writing-v4` той же модели оставался один результат без версии. Теперь оба замера сосуществуют,
а повторное слияние каждого идемпотентно — проверено на настоящем журнале `writing-v4` совпадением
SHA-256 набора до и после.

Та же тройка проведена через отчёт и ручной опросник. `quality:check` принимает
`--prompt-version=<id>`; если после фильтра остались разные модели или версии, он печатает рамку
предупреждения и поле `warning`. Старая запись без версии остаётся отдельным источником
`promptVersion: null`: код не приписывает ей текущий промпт и не предлагает ложную команду, будто
такую запись можно выбрать как именованную версию. Метка опросника несёт `promptVersion`, поэтому
суждение о разборе `writing-v4` не может лечь в соседний прогон той же модели на `writing-v3`.

Пять сохранённых содержательных журналов заново слиты в набор без вызова ИИ. Это восстановило
замер, который прежняя сводка потеряла вслед за данными: **`grok-4.5 / writing-v3` был пятым
платным замером**, а не отсутствующим. Коммит `8a94691` и журнал фиксируют его 42 вызова: схема
90,5 %, среднее отклонение 1,39, стабильность 71,4 %, точное совпадение 23,7 %. Поздний замер
`writing-v4` той же модели затёр его в `aiRuns`, после чего HANDOFF ошибочно назвал замеров четыре.
Теперь в наборе отдельно и с явным происхождением лежат пять серий:

| Модель | Промпт | Схема | Отклонение | Стабильность | Точное совпадение |
|---|---|---:|---:|---:|---:|
| `grok-4.3` | `writing-v2` | 92,9 % | 1,62 | 85,7 % | 15,4 % |
| `grok-4.20-non-reasoning` | `writing-v2` | 59,5 % | 2,28 | 42,9 % | 16,0 % |
| `grok-4.3` | `writing-v3` | 100 % | 2,19 | 71,4 % | 7,1 % |
| `grok-4.5` | `writing-v3` | 90,5 % | 1,39 | 71,4 % | 23,7 % |
| `grok-4.5` | `writing-v4` | 100 % | 1,52 | 90,5 % | 21,4 % |

Три прежние серии без `promptVersion` намеренно сохранены как неизвестные, а не переименованы:
их агрегаты совпадают с именованными журналами, но само поле происхождения в них отсутствовало.
за измерение. Пересборка опросника также хранит старый ответ по полной тройке: суждение о разборе
`writing-v3` не переносится в лист `writing-v4`. Формулы метрик, пороги §11.3, промпт и сырые
журналы не менялись. Тестов стало 380 (379 проходят, 1 пропущен, 0 падают).

## Что остаётся за владельцем в этом прогоне

Всё перечисленное расписано по шагам в разделе «Порядок прогона: от условия до отчёта»
в [`quality/README.md`](quality/README.md) — там же ключи команд и разбор полей отчёта.

- ~~Цифры трёх круговых диаграмм.~~ **Сделано 31 июля 2026 года:** владелец перенёс проценты,
  `npm run quality:merge-charts` влил их в набор. Все 21 работа несёт условие в форме, которую
  принимает промпт — 12 работ задания 37 и 9 задания 38. Три перенесённые помечены тегом
  `assignment-typed`: их цифры прочитаны человеком с картинки и сверить их не с чем.
- **Ключи провайдеров в `.env`** — `XAI_API_KEY` или `GROQ_API_KEY`. На машине `.env` отсутствует,
  и без него прогон невозможен. Значения — дело владельца, агент работает с именами переменных.
- **Сам платный прогон.** `npm run quality:run` запускает владелец, а не агент. Полученный журнал
  вливается в набор командой `npm run quality:merge-runs -- quality/runs/<файл>.jsonl`; сырой
  журнал остаётся у владельца — в репозиторий он не попадает по `.gitignore`.
- **Проход по опроснику разборов.** Инструмент готов (тикет 07), пройти его — дело владельца:
  после слияния журнала `npm run quality:worksheet-review -- quality/runs/<файл>.jsonl` соберёт
  `quality/review-worksheet.md`, а `npm run quality:merge-review` вольёт ответы в набор.
  Преподавателей в проекте нет; без этого прохода три пункта §11.2 останутся честно помеченными
  как неизмеренные.

## Известные остатки, не входящие в этот прогон

- **Объём эталонного набора.** §11.1 требует 20 работ задания 37 и 30 задания 38; есть 12 и 9.
  `--release` откажет по объёму, и это правильно. Пути пополнения — в HANDOFF.
- **Устная часть.** `speaking-3-fipi.json` — 14 интервью без прогонов ИИ. Отдельная работа по
  тому же образцу.
- **Таксономия критических ошибок.** Пока `expectedCriticalErrors` пуст у всех работ, полнота
  обнаружения критических ошибок не измеряется ничем.
- **Персональная дневная квота ИИ.** Решение владельца 31 июля 2026 года: лимит станет
  персональным и будет зависеть от уровня подписки. Сегодня `hasAiBudget()` в
  `middleware/subscription.js` считает `AI_DAILY_REQUEST_BUDGET` на всех сразу, без фильтра по
  пользователю: один активный ученик может выесть общий дневной бюджет, и остальные получат
  `503 AI_BUDGET_EXHAUSTED`. На сотне учеников это тяжёлый режим отказа.
- **В образ копируется всё дерево** — `test/`, `e2e/`, `docs/`, `quality/`, `.scratch/`.
  Прежнее поведение, не регрессия; кандидат на отдельный тикет.

---

# Закрытый прогон — производительность frontend и сборка Vite

Спека: [.scratch/frontend-performance-vite/spec.md](.scratch/frontend-performance-vite/spec.md)
Тикеты: [.scratch/frontend-performance-vite/issues/](.scratch/frontend-performance-vite/issues/)

| № | Что даёт | Статус |
|---|---|---|
| 01 | Записана базовая линия производительности — с чем сравнивать | done |
| 02 | Frontend переведён на ES-модули: подготовка к ленивой загрузке | done |
| 03 | Экраны приезжают по требованию, а не все сразу при запуске | done |
| 04 | Вход в демо перестал подвисать: INP 56 мс при бюджете 200 | done |
| 05 | Первый экран не ждёт загрузки всего учебного контента | wontfix — закрыт тикетом 03, остаток держит §6.1 |
| 06 | Сборка Vite: 81,9 → 54,5 КБ по сети на первой загрузке | done |
| 07 | Семь пунктов разделов 4 и 20 ТЗ проверены и размечены по факту | done |
| 08 | Замер повторён, бюджеты закреплены тестом от регрессии | done |
| 09 | ТЗ и инструкции по развёртыванию отражают новое состояние | done |
| 10 | Образ сам собирает frontend, а не берёт его с машины владельца | done |

Прогон закончен: восемь тикетов выполнены, один закрыт как wontfix по решению владельца.

Тикет 10 добавлен сверх исходных девяти и закрыт: образ собирает frontend отдельной стадией, а
`dist/` исключён из контекста сборки. Содержимое образа определяется теперь репозиторием и ничем
больше — проверено на живом Docker сборкой при удалённом и при намеренно испорченном локальном
`dist/`, и запущенным контейнером с PostgreSQL.

Попутно это починило staging. `scripts/staging-deploy.sh` разворачивает `git archive`, где `dist/`
отсутствует по `.gitignore`, и запускает `docker compose up -d --build`. До тикета 10 staging
гарантированно работал из `public/` без бандла; теперь собирает сам, тем же `Dockerfile`.

## Что получилось по числам

| Показатель | До прогона | После | Бюджет |
|---|---:|---:|---:|
| INP | 224 мс | 56 мс | 200 мс |
| LCP | 44 мс | 92–100 мс | 2500 мс |
| CLS | 0.000 | 0.000 | 0.1 |
| Индикатор проверки ИИ | 34 мс | 34–36 мс | 200 мс |
| JavaScript первой загрузки | 350 КБ (несжатых) | 81,9 КБ по сети, 229 КБ несжатых | 150 КБ по сети |
| `public/app.js` | 296 326 байт | 68 129 байт | — |

Подробности замера, оговорки о единицах и трасса причины INP — в
[`docs/PERFORMANCE_BASELINE.md`](docs/PERFORMANCE_BASELINE.md).

Готовность по полному ТЗ: **89,7% → 91,4% (436 из 477)**. Число считается скриптом
`npm run tz:readiness -- "<путь к ТЗ>"`; правило описано в самом ТЗ, в разделе «Статус выполнения».
Закрыты разделы 5.1 (решением владельца, ADR 0001), 19 (по факту замера) и пункт 4.2 «модуль `app`».

## Что остаётся за владельцем по проекту в целом

- `npm install` после появления `vite` в `devDependencies` — тикет 06.
- Ротация ранее использовавшихся секретов, раздел 14 ТЗ.
- Приёмка на живом iPhone Safari и Android Chrome, раздел 18.4 ТЗ.
- Набор работ для методической проверки ИИ, раздел 11 ТЗ — 28 из 40 открытых требований strict.
- Семидневный soak на staging: прежний отсчёт не относится к текущему кандидату с локальными
  коммитами; новый отсчёт начнётся после разрешённого владельцем deploy на staging.
- Повторить dependency audit при доступном npm registry; локальные performance/accessibility и
  secret scans уже прошли в финальном аудите.
- Деплой на staging и production. Push в `production-hardening` разворачивает staging и сбрасывает
  отсчёт soak — только по слову владельца. Ветка намеренно не отправлена; что именно накопилось,
  показывает `git log origin/production-hardening..HEAD`.
- Экспериментальная функция после прохождения оставшихся ворот открывается **всем пользователям с
  активным доступом**, без искусственного лимита 1–5 или 100 аккаунтов.

---

# Экспериментальная ИИ-оценка свободных ответов

Спека: [.scratch/experimental-ai-assessment/spec.md](.scratch/experimental-ai-assessment/spec.md)
Тикеты: [.scratch/experimental-ai-assessment/issues/](.scratch/experimental-ai-assessment/issues/)

| № | Что даёт | Статус |
|---|---|---|
| 01 | Явный экспериментальный статус результата в API, интерфейсе и ТЗ | done |
| 02 | Объективный ноль для слишком короткой письменной работы | done |
| 03 | Полное происхождение каждого сохранённого прогона | done |

---

# Объективное правило превышения объёма письменной работы

Спека: [.scratch/writing-overlength-rule/spec.md](.scratch/writing-overlength-rule/spec.md)
Тикеты: [.scratch/writing-overlength-rule/issues/](.scratch/writing-overlength-rule/issues/)

| № | Что даёт | Статус |
|---|---|---|
| 01 | Длинная работа проверяется только в первых 140/250 словах, а полный и оценённый тексты сохраняются раздельно | done |

Тикет 01 закрыт: сервер детерминированно оставляет весь ответ на 154/275 словах и, начиная с
155/276, передаёт провайдеру и программным фактам только первые 140/250 слов. API сообщает полный
и оценённый объём, экран показывает область оценивания рядом с неизменным экспериментальным
предупреждением, а файловое и PostgreSQL-хранилища раздельно сохраняют `answer` и
`evaluated_answer`. Миграция 020 совместимо заполняет новое поле для прежних строк. Бесплатные
сквозные тесты выполнены только с подставным провайдером; платных прогонов не было. §11 остаётся
0/28, готовность по ТЗ — 91,4%. Тестов стало 407 (406 проходят, 1 пропущен).

---

# Профиль готовности экспериментального запуска

Спека: [.scratch/experimental-release-profile/spec.md](.scratch/experimental-release-profile/spec.md)
Тикеты: [.scratch/experimental-release-profile/issues/](.scratch/experimental-release-profile/issues/)

| № | Что даёт | Статус |
|---|---|---|
| 01 | Отдельные строгий и экспериментальный расчёты готовности без сокрытия §11 | done |
| 02 | Локальный релизный аудит с доказательствами по критериям §24 | done |
| 03 | Строгие server-owned контракты ответов STT/TTS-провайдеров | done |
| 04 | Disposable PostgreSQL integration с миграциями, изоляцией и cleanup | done |
| 05 | Повторный локальный аудит и конкретный чек-лист оставшихся ворот | done |

Работа не включает push, deploy, ротацию секретов и платные ИИ-вызовы. Экспериментальный профиль
исключает методическую валидацию из области обещаний запуска, но не объявляет её выполненной.

Тикет 01 закрыт: `strict` по умолчанию воспроизводит 436/477 и 41 открытый пункт, а `experimental`
показывает 436/448, 12 открытых и 29 исключённых требований (весь §11 и критерий §24.12). Исключения
остаются открытыми в строгом профиле; критерий §24.1 передан в аудит тикета 02. CLI-тесты 4/4, полный набор —
410 пройдено и 1 штатно пропущен; lint/check зелёные. Двухосевой review завершён без открытых замечаний.

Тикет 02 закрыт локальным аудитом кандидата `0cebd75`. Прошли lint/check, 410 из 411 тестов при
одном штатном skip, Chromium/Firefox/Android/iPhone-WebKit E2E, performance, frontend build, два
secret scan и 44/44 целевых теста строгих ИИ-схем. `npm audit` не получил данные от registry и
честно записан ограничением. Общим доказан только §24.2. PostgreSQL integration был штатно
пропущен, поэтому §24.4 не закрыт; 44/44 schema-теста доказывают content/writing/speaking, но не
строгий provider-ответ STT/TTS, поэтому §24.10 и §24.1 также открыты. Итог: strict 437/477 (91,6%),
experimental 437/448 (97,5%). Новый семидневный staging soak ещё не начат; физические устройства,
PWA install, внешние alerts, ротация секретов и полное восстановление на втором сервере остаются
ручными воротами. Двухосевой review: Standards — 0 замечаний; Spec — 3 замечания, все устранены.
Подробности — в [`docs/EXPERIMENTAL_RELEASE_AUDIT.md`](docs/EXPERIMENTAL_RELEASE_AUDIT.md).

Тикет 03 закрыт: `/api/v1/stt` принимает только bounded `application/json` с точными полями,
нормализованным текстом и duration 0–300 секунд; `/api/v1/tts` кэширует только bounded
`audio/mpeg`, а невалидный primary-ответ передаёт прежнему Edge fallback. Целевые тесты 14/14,
полный набор — 424 из 425 при одном штатном PostgreSQL skip; lint/check зелёные. §24.10 этим
тикетом не объявлен закрытым: окончательная отметка остаётся аудиту тикета 05. Двухосевой review:
Standards — 2 P3 замечания устранены; Spec — 1 P2 замечание устранено.

Тикет 04 закрыт: `npm run test:postgres` поднимает уникальный test-only Compose project с
PostgreSQL 17 на случайном loopback-порту, ждёт healthcheck, применяет все 20 миграций и запускает
существующий repository integration — `1/1` проходит, `0` skip. Два последовательных прогона
начались с пустой БД и завершились удалением контейнера, сети и volume; намеренно сломанный прогон
мигратора вернул non-zero и также не оставил ресурсов. CI использует ту же команду. Обычный набор
остаётся Docker-независимым: 424 из 425 тестов проходят при одном защитном PostgreSQL skip;
lint/check зелёные. §24.4 не закрывался — это решение оставлено полному аудиту тикета 05.
Двухосевой review: Standards — 1 P2, Spec — 1 P1; оба замечания устранены.

Тикет 05 провёл повторный аудит application candidate `661a98974aac7bbc69dc321a876eacee65ec9819`.
Прошли lint/check, 425-test suite (424 pass, 1 защитный PostgreSQL skip), обязательный disposable
PostgreSQL `1/1` pass без skip с миграциями `001`–`020` и cleanup, Chromium до и после build,
Firefox/Android/iPhone-WebKit
E2E, performance, frontend build, оба secret scan, `58/58` строгих AI/media tests и quality engineering
smoke. §24.4 и §24.10 закрыты в обоих профилях; §24.1 засчитан только для experimental.
Strict остаётся открыт из-за §11 `0/28`; §24.12 strict-open/experimental-excluded. Итоги CLI: strict
`439/477 = 92.0%`, 38 open; experimental `440/448 = 98.2%`, 8 open, 29 excluded. Внешнее ТЗ обновлено вне Git.
Подробный аудит — в [`docs/EXPERIMENTAL_RELEASE_AUDIT.md`](docs/EXPERIMENTAL_RELEASE_AUDIT.md), а owner-approved
manual gates — в [`docs/EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md`](docs/EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md).
Push/deploy, ротация, физические устройства, soak, PWA install, external alert delivery и recovery на втором
сервере не выполнялись. Двухосевой review относительно `661a989`: Standards — 3 замечания, Spec — 2;
все устранены. Post-build `dist/public` E2E прошёл, rollback использует root-owned helper, recovery не получает
production credentials, три доказанных P0 отмечены во внешнем ТЗ; итог сохранён одним amended commit.

---

# Voice Error Tutor для ЕГЭ

Спека: [.scratch/voice-ege-tutor/spec.md](.scratch/voice-ege-tutor/spec.md)
Исследование: [.scratch/voice-ege-tutor/competitive-research.md](.scratch/voice-ege-tutor/competitive-research.md)
Тикеты: [.scratch/voice-ege-tutor/issues/](.scratch/voice-ege-tutor/issues/)

Ветка: `feature/voice-ege-tutor`. Текущий staging candidate и его семидневный soak не изменяются.

| № | Что даёт | Статус |
|---|---|---|
| 01 | Premium-доступ, дневные/месячные минуты и защита от параллельных сессий | done |
| 02 | Полный голосовой разбор ошибок грамматики и лексики с fallback | done |
| 03 | Контекстный голосовой разбор чтения и аудирования | done |
| 04 | Контекстный голосовой разбор письма и устной части | done |
| 05 | Поиск отсутствующих правил по доверенным источникам и очередь проверки | done |
| 06 | Карта освоенных ошибок и возвращённых потенциальных баллов | done |
| 07 | Приватность, безопасность, observability и сквозная проверка | done |
| 08 | Premium commerce, честные квоты и полное grammar/lexicon-покрытие | done |
| 09 | Полный discovery/text/barge-in/report педагогический цикл | done |
| 10 | Enforceable realtime proxy и финальная security parity | done |

Тикет 01 закрыт: base и Premium разделены правом `voice_tutor`; UTC-квоты 10/120 минут,
идемпотентный резерв одной активной сессии, возврат остатка, экспорт/удаление и профильный UI готовы.

Тикет 02 закрыт: исходная ошибка grammar/lexicon сначала проверяется сервером, затем получает server-owned bounded capsule по существующей попытке,
проходят `diagnose → explain → micro_check → transfer_task → resolved|fallback|ended` с серверной
проверкой ответов и одноразовым nonce. xAI credential создаётся через внедряемый transport без передачи
основного ключа; браузерный realtime WebSocket/audio transport и общая bottom sheet поддерживают микрофон,
временные субтитры, таймер, остаток квоты, доступный возврат и AI-text/canonical-local fallback того же capsule
без повторного списания voice quota. Каждый text-шаг заново собирает точный capsule по source attempt;
ошибка text AI атомарно переключает текущую сессию на canonical-local режим. Перед каждым AI-text
turn заново проверяется актуальный `text_processing` consent; voice consent его не заменяет.

Тикет 03 закрыт: reading/listening result flow сначала отправляет полный завершённый canonical set,
а сервер создаёт отдельные детерминированные error attempts только после проверки всех вариантов.
Это работает во встроенных и динамически сгенерированных practice/exam наборах: shared AI result
копируется в owner-bound `generated_tasks`, set/item IDs связывают request hash и content digest,
а listening evidence обязано быть точной цитатой из transcript. Общий bottom-sheet adapter монтирует
кнопки только после завершения; fallback заново собирает тот же bounded capsule. Replay результата
сверяется по answer hash. Целевые тесты 32/32, полный набор 455 (454 pass, 1 PostgreSQL skip),
`lint`, `check` и frontend build проходят; оба финальных review не нашли нарушений.

Тикет 04 закрыт: writing/speaking evaluation API возвращает только server-issued pointer на уже
сохранённую попытку. Voice Tutor заново загружает owner-bound completed attempt, валидирует assignment
и review, а evaluated writing text/speaking transcript использует только в transient capsule для
провайдера. Полный ответ не попадает в публичный или сохранённый Voice Tutor session/export, tutor не
меняет score и не вызывает evaluation повторно. Общий bottom sheet подключён к результатам практики и
устного пробника; targeted tests 8/8, полный набор 459 (458 pass, 1 PostgreSQL skip), `lint`, `check` и
frontend build проходят.

Тикет 05 закрыт: server-only trusted-rule workflow получает только curated URL из настраиваемого
allowlist, проверяет HTTPS/domain/path, публичный DNS с pinning, redirects, абсолютный deadline, MIME и bytes.
Fetched текст остаётся недоверенными данными fixed-system evidence operation и не сохраняется;
rule card содержит bounded правило, skill/год, URL, retrieval time и content hashes. Только два
согласующихся независимых authority/domain дают явно предварительный результат `pending_review`.
Admin-only approve/reject идемпотентны, а общий canonical lookup видит только `approved`.
Реальное встроенное задание без локального правила создаёт owner-bound discovery session; браузер
показывает provisional explanation и HTTPS-ссылки в том же разборе, а одобренная карточка входит в
следующий session capsule без повторного поиска. File/PostgreSQL/export/delete parity подтверждены:
targeted workflow 6/6, frontend 6/6, disposable PostgreSQL 1/1, полный набор 466
(465 pass, 1 штатный PostgreSQL skip), `lint`, `check`, frontend build и secret scans проходят.

Тикет 06 закрыт: только проверенный `transfer_answer` FSM создаёт bounded recovery outcome и два
новых server-owned аналога day-1/day-7, привязанных к нормализованным skill/rule. Исходное задание,
сессионный transfer и клиентские skill/points не засчитываются; отправленный repeat-ответ не
сохраняется. Overdue остаётся доступным, поздний day-1 сохраняет шестидневный интервал до day-7,
а `relapsed` возникает только после проверенной ошибки, не из-за бездействия. Current-user API и
адаптивная карта показывают open/recovered/relapsed, due repeats, минуты и явно неофициальный
potential; admin metrics содержат только агрегаты. File/PostgreSQL/export/delete parity подтверждены:
targeted tests 18/18, полный набор 473 (472 pass, 1 штатный PostgreSQL skip), disposable PostgreSQL
1/1, `lint`, `check`, frontend build и оба secret scans проходят.

Тикет 07 закрыт: credential выдаётся только после актуального voice consent, Premium/quota,
server-owned capsule checks и явного owner gate для риска unbound bearer; feature flag, cost kill
switch и обязательный неподтверждённый ZDR fail closed до provider transport, сохраняя тот же разбор
в text/local fallback. xAI handshake соответствует официальному ephemeral-token контракту: только
`expires_after.seconds` с фиксированным окном подключения 60 секунд, versioned model в URL,
`xai-client-secret` и bounded server-issued `session.update` без server-owned reference и массивов
ответов будущих проверок. Browser realtime ждёт ACK, затем вызывает authenticated idempotent
`/activate`; backend однократно ставит `voice_activated_at`, и browser создаёт audio graph только
после успешного ответа. Transport ограничивает bytes/rate/order/tool calls и replay, принимает обе
совместимые формы `response.created`, а runtime error/close/ACK timeout автоматически закрывает media
и продолжает тот же capsule через text/local. Provider diagnostics, raw audio, полный
transcript, реплики и временные субтитры не попадают в persistence/export/logs/metrics/evidence.
До activation списание равно нулю; после него elapsed voice seconds не возвращаются при runtime
fallback и остаются в provider cost metrics даже при финальном text/local delivery. Provider/model/
prompt provenance не теряется при text/local downgrade; legacy quota-only строки исключены.
File/PostgreSQL export/delete
parity, owner locks против concurrent orphan rule report и миграция 025 проверены на disposable
PostgreSQL. Pending/rejected rule reports удаляются с аккаунтом, approved canonical остаётся без
creator/reviewer identity. Бесплатный Playwright E2E прошёл настоящий browser transport и полный
session.updated → runtime error → local fallback → micro-check → transfer → recovery-map loop через
локальные fake HTTP/WebSocket. Ограничение direct xAI bearer и replacement trigger зафиксированы в ADR.
Полный набор 486 (485 pass, 1 штатный PostgreSQL skip), targeted 48/48, disposable PostgreSQL 1/1,
`lint`, `check`, frontend build, functional/performance E2E и оба secret scans проходят; платных
вызовов и изменений staging/soak не было.

Тикет 08 закрыт: базовый payment flow сохранён, Premium paywall создаёт идемпотентную заявку, а
только admin approval в одной file/PostgreSQL mutation продлевает подписку и bounded
`voice_tutor`; rejection/revoke/expiry видны через status и `/me`, решения имеют audit/event trail.
Резерв сессии теперь равен минимуму session cap и положительных daily/monthly остатков, поэтому
доступны все 600/7200 секунд без отрицательных значений. Production отклоняет blank/latest/
unversioned `XAI_VOICE_MODEL` до provider call. Generated server catalog покрывает 218 текущих
grammar/word-formation/collocation paths и 897 vocabulary paths; generated AI exercises связаны с
owner-bound typed `generated_tasks`, client reference не принимается. Полный набор 494 (493 pass,
1 штатный PostgreSQL skip), disposable PostgreSQL 1/1, `lint`, `check`, frontend build, functional
E2E и оба secret scans проходят; платных вызовов, push, deploy и изменений staging не было.

Тикет 09 закрыт: production discovery получает кандидаты через server-only xAI Responses web search
с allowlist и принимает только structured URL citations; каждый источник затем проходит прежние
SSRF/DNS/MIME/size проверки, а provisional rule атомарно связывается только с текущей owner-bound
session. Текстовый режим поддерживает до трёх transient уточнений без сохранения реплик и без обхода
FSM. Browser Realtime останавливает queued audio на server-VAD speech-start и отправляет bounded
cancel/truncate; replay и события вне порядка fail closed. Structured learner reports не принимают
свободный текст, имеют admin review/audit и file/PostgreSQL/export/delete parity. Persisted capsule
сведена к IDs, versions и hash, полный контекст реконструируется server-side. Playwright E2E начинает
разбор с настоящей grammar error card и проходит fake realtime tool cycle до recovery map. Полный
набор 502 (501 pass, 1 штатный PostgreSQL skip), targeted 25/25, disposable PostgreSQL 1/1, `lint`,
`check`, frontend build, functional/performance E2E и оба secret scans проходят; платных вызовов,
push, deploy и изменений staging не было.

Тикет 10 закрыт: browser больше не получает xAI bearer или ephemeral credential — same-origin
WebSocket принимает только короткий одноразовый owner-bound app ticket, а server-owned proxy сам
открывает pinned `grok-voice-think-fast-1.0`, отправляет bounded конфигурацию PCM16 24 kHz mono и
пропускает только разрешённые lifecycle/audio/tool frames. Provider ACK атомарно активирует резерв;
повтор ticket и события вне порядка fail closed. Hard deadline, feature/cost/ZDR switch, отзыв
актуального voice consent и потеря Premium завершают уже активный канал. При чистом завершении
учитываются точно наблюдённые input+output PCM bytes, при любой неоднозначности сохраняется полный
резерв; клиентское время не является источником биллинга. Lost `201` имеет один идемпотентный
reissue без второго резерва. File/PostgreSQL сериализуют consume/finalize, review/delete и допускают
один approved canonical на skill/year; миграции 029–030 проверены на disposable PostgreSQL. Реальный
локальный fake HTTP+WebSocket E2E подтверждает server-only основной ключ, конфигурацию, audio,
barge-in, runtime fallback, quota/recovery/privacy и отсутствие learner answer/audio/transcript в
export. Upgrade budgets и pending-handshake ceilings защищают proxy до consume; provider call ID
проходит точную server-side correlation только через успешный nonce transition. Finalization имеет
bounded retry/PII-free telemetry, shutdown ограничен по времени, а закрытие sheet отменяет поздний
create/reissue/discovery/microphone без скрытого захвата аудио. One-trusted-proxy IP budgets очищают
expired identities, provider handshake slots удерживаются до ACK/timeout, voice FSM требует exact
call ID, а потерянный text/local 201 один раз получает новый nonce без повторного AI call. Rate-map
хранит process-local HMAC identities и независимо очищает TTL; единый deadline покрывает
auth/repository/capsule/provider ACK, каждая finalization attempt ограничена по времени, а partial
`delivery_mode=null` атомарно завершается как local с нулевым billable time. Raw provider JSON не
пересылается: browser получает только server-built allowlisted projections; PostgreSQL завершает или
разрывает timed-out finalization до следующего retry. Provisional voice без ticket/activation получает
согласованную пару first ticket + rotated nonce либо zero-billable local. Ticket expiry всегда ограничен
session deadline, а оба PostgreSQL pool обрабатывают idle-client failure
фиксированной PII-free telemetry. Полный набор 532
(529 pass, 3 штатных PostgreSQL skip), расширенный targeted 92/92, disposable
PostgreSQL 3/3, `lint`, `check`, frontend build, два последовательных functional E2E, performance и
оба secret scans проходят; платных вызовов, push, deploy и изменений staging не было.
Whole-feature аудит дополнительно закрыл атомарный budget/rate claim для `voice_tutor_text` и
сохранил text/local-разбор при нулевом остатке голосовых минут через zero-billable reservation.
Type-mode vocabulary больше не показывает accepted word в контексте; конкретные слова и сочетания
получают отдельный `skill_id`, а micro-check, transfer и два recovery-аналога всегда относятся к нему.
Лексические аналоги используют четыре других авторских контекста и разные позиции верного варианта,
поэтому исходный перевод или одно нажатие нельзя повторить; при нехватке контекстов tracer fail closed.
Все четыре задания нормализованно отличны от исходного и друг от друга.
Доказательства письма/говорения фильтруются
по выбранному критерию и не подставляют несвязанное первое исправление. Добавлена additive
миграция 030 с file/PostgreSQL parity.
## Adaptive EGE Learning Plan (implementation started 2026-08-04)

Status: tickets 01–08 are complete on `feature/adaptive-learning-plan`. The feature is stacked on the completed Voice Tutor branch and will not be pushed, merged or deployed without a separate owner decision.

Agreed product contract: target EGE score/date is primary; a short diagnostic or existing evidence builds a confidence-labelled micro-skill profile; an honest forecast and stable weekly budget feed 15–120 minute executable sessions; real module outcomes update the living plan; free/base/Premium boundaries are server-enforced. CEFR/IELTS is secondary and approximate, not an official IELTS result.

Implementation tracker:

- [x] 01 Goal and evidence-backed profile tracer
- [x] 02 Short adaptive diagnostic
- [x] 03 Honest forecast and stable weekly allocation
- [x] 04 Duration-aware learning session composer
- [x] 05 Real module execution and evidence feedback
- [x] 06 Retention loop and Premium depth
- [x] 07 Commercial boundaries, complete UI and reports
- [x] 08 Hardening, E2E and release evidence

Detailed source of truth: `.scratch/adaptive-learning-plan/spec.md` and `.scratch/adaptive-learning-plan/issues/`.

Ticket 01 complete: the authenticated tracer now stores revisioned EGE goals and builds a
confidence-labelled profile from owner-bound attempts plus validated Voice Tutor recovery/retention
evidence. It includes the versioned six-module taxonomy and weighting policy, explicit
client-reported/assisted/independent provenance and per-skill trust states. Exact aliases cover all
21 skills; `voice-tutor-skill-compat-v2` maps all current production Voice skill families, including
nested IDs and grammar-origin word-formation/collocation evidence, to the intended skill. Known
families with a wrong module are rejected instead of falling through to an unrelated default;
unknown recovery/repeat IDs are uncredited. Speaking tasks 1–4 publish their intended v2 mappings,
including the dedicated reading-aloud skill for task 1. Service
`voice_tutor_*` attempts are ignored by the adaptive scorer because their exact recovery/repeat
ledger is authoritative, preventing double credit into a module default.
Assisted/client-only evidence is scoring-bounded, cannot reduce uncertainty, exceed 49
mastery or establish a skill; forged high-volume public history remains preliminary guidance. The
whole profile is established only at 21/21 independently confirmed skills. Migration 031 has
file/PostgreSQL and export/delete parity. A separate monotonic calculation revision permits a newer
algorithm to recompute the same evidence but blocks every older algorithm; the append-only watermark
never lets a lower source count replace a higher one and accepts larger backfills even with an older
latest timestamp. PostgreSQL reads all evidence sources in one SQL snapshot and profile plus estimates
in one snapshot for get/export. Concurrent saves capture the same snapshot on the transaction client
before commit, so they create neither orphan repeats nor mixed revisions and do not exhaust the pool.
Overview uses the authoritative save result, including when a stale calculation is rejected. OpenAPI 3.0 nullable references
and UI wording explicitly expose preliminary versus confirmed data. File/PostgreSQL profile save/get
share one allowlisted DTO with nested sorted estimates, ISO/null timestamps and no owner/internal
fields; adaptive exports reuse the same mapper. Adaptive goals use a second shared allowlisted mapper
for file/PostgreSQL save/get/API/export with identical ISO/null created/updated timestamps.
`ADAPTIVE_LEARNING_ENABLED=false`
still fails closed across the unregistered API, `/me` projection and hidden/no-fetch UI entry.
Verification: adaptive regressions plus file repository contracts 35/35, shared file/PostgreSQL DTO
contracts, full suite 551 pass with 8 expected no-URL PostgreSQL skips, disposable PostgreSQL 8/8,
lint/check, frontend build and both secret scans; no paid calls, push,
deploy or staging changes.

Ticket 02 complete: a new learner can start and resume one owner-bound short diagnostic from a
registry that versions `ege-short-diagnostic-v1` together with its progress, stop and expiry policy.
The server owns prompts, answers and skill mappings. Accepted answers privately adapt the next
uncertain/high-impact probe, but no diagnostic response becomes profile evidence before successful
completion. The public item projection never exposes an answer key or skill mapping, and the browser
submits only item/choice IDs. The run targets 10 items/about 15 minutes, stops no later than 12 items
or 20 minutes, and the same deadline covers both in-progress and ready states. It has no hint/retry
path and uses local browser speech without paid calls. Replayable listening is explicitly assisted
with explanation code `assisted_local_tts_diagnostic`: it cannot establish independent mastery or
reduce uncertainty, and the learner sees the measurement limitation.

New start keys are bounded before overview calculation by a finite per-user hourly rate. Durable
owner claims retain exact start snapshots for at most 24 hours, are capped at 16 live claims and are
pruned; exact retained keys bypass new-key throttling. Each accepted answer stores a separate safe
allowlisted replay snapshot, so its retry returns the originally observed state even after later
answers or completion. Internal claim fingerprints and replay snapshots are not exported. File and
PostgreSQL implementations share concurrency, expiry, retention, export and deletion contracts.
All reads, progress, selection, stopping, expiry and scoring use the session's stored catalog-policy
pair; v1 remains available while unknown versions fail closed.

Migration 032, OpenAPI/schema/retention documentation and the accessible progress-card flow share
the same bounded contract. A dedicated real Chromium tracer covers keyboard start/choice/submit,
reload/current identity, exact answer replay after later answers and completion, fake local speech
and completion with all providers disabled. Verification: targeted diagnostic/adaptive/file tests
53/53, full suite 569 pass with 9 expected no-URL PostgreSQL skips, disposable PostgreSQL 9/9, real
Chromium E2E, lint/check, frontend build and both secret scans; no paid calls, push, deploy or staging
changes.

Ticket 03 complete: `adaptive-plan-v1` turns the learner's current EGE goal and authoritative
evidence profile into an honest rule-based score range with confidence, explicit assumptions,
required weekly minutes and concrete increase-time/adjust-target choices. It makes no score promise.
Required time is the upward five-minute rounding of the exact inverse capacity equation, including
uncertainty and the same 0.75 effectiveness factor used by the range. An increase-time choice is always
strictly above current time, never exceeds the savable 2520-minute maximum and truthfully reports whether
it is sufficient. When the learner is already at the maximum, the plan offers only valid alternatives.
The weekly priority combines target gap, EGE impact, due/overdue retention, deadline pressure and
uncertainty. Every skill and module has reason codes; high uncertainty schedules a diagnostic probe
instead of claiming mastery. Integer allocations across all 12 micro-skills and six modules each
total exactly 100%, and an ordinary recalculation moves no visible share by more than 10 percentage
points. Deadline pressure changes relative high-impact/large-gap priorities. Ordinary overdue work
and `critical_due` work both remain bounded; only a goal revision change resets the allocation.
`critical_retention_expiry` remains a visible priority reason, but its persistence bypass is disabled
until Ticket 06 supplies owner/profile-bound persisted expiry that the repository itself can derive.
The first revision is already checked for exact canonical 6-module/12-skill membership, 100% totals
and matching module sums. The UTC start of `recalculationBucket` is the shared deterministic calculation
instant for forecast weeks, deadline/critical priority, allocation and `calculatedAt`, so morning and
23:59 inputs with one fingerprint produce one exact plan. The bucket before the exam retains `1/7` week;
the exam-date bucket is expired. Actual persistence receipt timestamps remain separate.
One SQL-calendar normalizer is shared by goal and plan DTOs (and retained-plan comparison), preserving
the local calendar components returned for PostgreSQL `DATE` instead of applying a UTC-day shift.

The authenticated overview, goal response and dedicated plan endpoint return the authoritative
owner-bound revision. A daily/evidence fingerprint includes the exact `base_plan_revision`; file
serialization and a PostgreSQL owner lock resolve current, enforce CAS and reject stale writes under
concurrency. One shared strict validator rejects malformed candidate/forecast/allocation/stability JSON,
outer/inner mismatches and a fingerprint that does not match the complete supplied metadata before any
duplicate lookup. A retained duplicate fingerprint replays only after an exact normalized comparison of
the candidate envelope and all plan semantics; only regenerated identity and actual receipt timestamps
are ignored. The current canonical evidence vector is now checked before that replay, so a historical
candidate cannot bypass evidence added after it was built; a bare captured hash or changed confidence/allocation/reason cannot replay. For every new candidate, the repository rebuilds the expected
plan under the same owner mutation/transaction from the full persisted goal, full profile with all 12
skill estimates and current plan; synthetic goal values, skill states, forecasts or allocations reject.
The route boundedly recomputes a CAS loser against the winning plan. The repository independently
checks the ±10 transition. Calculation revision precedes append-only count/time/version ordering,
so a newer algorithm may intentionally filter sources and an older one can never overwrite it.
Exact old-goal fingerprints still return current after a goal change, but unknown stale fingerprints
fail closed. Goal PUT returns one matching current goal/profile/plan snapshot with explicit
created/replayed/superseded metadata even under old-key replay and concurrency. Migration 033,
shared allowlisted DTOs, export/deletion and retention/schema/OpenAPI documentation have file/PG
parity. The progress screen exposes the range, confidence caveat, explained weekly focus and
feasibility choices, and the real Chromium diagnostic flow verifies that completed diagnostic
evidence creates the next plan revision without provider calls. Verification: targeted plan 25/25,
adaptive/file regressions 81/81, full suite 597 pass with 10 expected no-URL PostgreSQL skips (607 total),
disposable PostgreSQL 10/10, real Chromium E2E, lint/check, frontend build and both secret scans;
no paid calls, push, deploy or staging changes.

Ticket 04 implementation complete: `adaptive-composer-v1` turns one persisted plan revision and a
15–120 minute request into a deterministic, explainable session over the rolling Monday-UTC weekly
budget. Every five-minute duration in the range composes exactly; sessions over 60 minutes reserve one
exact 10-minute break. Learning blocks obey their real consumer minimums—15 minutes for vocabulary,
grammar, gist listening/reading and speaking interaction; 20 for detail listening/reading and speaking
monologue; 25 for writing email; 30 for writing essay—and never exceed 30 minutes. Adjacent modules are
diversified when content permits. Due reviews, prerequisite support, weekly deficits, uncertainty probes
and target gaps have bounded reason codes. The versioned `adaptive-content-v1` registry points only at
real built-in module screens and canonical built-in Writing tasks. Vocabulary lexical choice launches the
existing `scr2` EGE word/SRS outcome. Word formation is not falsely advertised: its unsupported allocation
is reported in `coverageGaps`. Its priority is explicitly assigned to lexical practice in the same module
with `content_coverage_fallback`; only a module with no consumer may fall back outside the module. Weekly
allocations are rolling priorities rather than hard caps: a meaningful 15–30 minute block may overshoot a
2–3 minute target, and persisted planned/selected overshoot lowers that skill and module's signed priority
in later sessions. `ADAPTIVE_SESSION_COVERAGE_GAP` is returned only when no exact meaningful sequence can
be made from any justified registered activities, not because one skill is unsupported or below a block minimum.

Authenticated preview/create/current/replace routes use strict schemas, server time, current/historical
owner-bound plan revisions and immutable idempotency response snapshots. One canonical fingerprint binds
the plan, registry, weekly snapshot and ID-free block payload; deterministic block IDs are revalidated
inside the serialized file mutation or PostgreSQL owner lock. The browser submits only
duration, preview fingerprint, block id and a bounded replacement reason; it cannot supply activities,
routes, scores or completion. One replacement preserves duration and block identity, updates the weekly
snapshot, skips the break when checking adjacent learning content and permanently consumes the replacement
allowance. Cross-owner lookups, stale fingerprints, malformed or repointed IDs, registered-activity swaps,
budget tampering, conflicting keys and tampered repository content are rejected without leaking existence.
Migration 034 and file/PostgreSQL repositories share owner locking, current-session uniqueness, CAS,
rolling week usage, allowlisted export and cascade deletion. Stored sessions contain opaque references
and structured counters only—no copied answer, essay, transcript or audio.

The accessible progress card supports presets, custom five-minute increments, a reasoned preview,
creation/current restore, one replacement and a real first-screen handoff; an existing current session is
resumed instead of allowing a second one. Real Chromium covers a 90-minute preview against a real
30-minute weekly plan, exact break, create,
replace and handoff with external providers blocked; the same run opens the real vocabulary SRS consumer
in forced lexical-choice mode and observes its rendered outcome. Final-repair verification: Ticket 04
targeted session tests 19/19, full suite 616 pass with 11 expected no-URL PostgreSQL skips (627 total),
disposable PostgreSQL 11/11, Chromium E2E, lint/check, frontend build, both secret scans and
`git diff --check`; no paid calls, push, deploy or staging changes.

Ticket 05 implementation complete: a learner now starts the persisted session through a server-issued,
two-hour opaque execution claim tied to the exact current block. The bearer is reconstructed by a
domain-separated HMAC and is absent from claim rows, mutation snapshots, export and evidence. Grammar,
vocabulary, reading, listening, writing, speaking and the fixed grammar exam consumer receive only an
allowlisted launch context and report completion through an existing persisted attempt. Browser-scored
module evidence remains `client_reported`; factual `exam_practice`, `planned_practice`, `scheduled_review`
or `ai_assisted_review` context is stored on a separate axis and never claims unseen, timed, unassisted or
retention work. Writing/Speaking accept only a completed server-owned review of the exact canonical task.

Start, advance and finish use owner-global immutable idempotency replays and CAS in both repositories.
The owner-bound, three-hour browser runtime durably preserves start/break/finish, the exact
attempt → bind → advance queue and a consumed-attempt recovery operation. If the attempt committed but
the response was lost, a later start returns that same attempt for an exact durable advance without
minting a second claim or attempt. Migration 036 revokes and detaches every legacy plaintext claim,
including consumed Writing/Speaking rows that lack new exact-task fields, while an idempotent rerun keeps
post-upgrade HMAC claims. Writing and Speaking cannot switch topic/assignment while a personal block is
active; the paid review remains on screen until an explicit return to the plan. The final screen lists
completed work, actual/planned time, evidence quality/context, plan revision change and next action.

Real Chromium now covers diagnostic and keyboard flow, a real client module, direct fixed exam launch,
the full persisted exam block, and exact Writing launch → local fake AI review → explicit return → finish.
Every external HTTPS provider is blocked during the run. Final gates: targeted execution/runtime
16/16; full suite 636 pass plus 11 expected no-URL PostgreSQL skips (647 total); disposable PostgreSQL
11/11; real Chromium E2E; lint/check, 17-asset frontend build, 407-file secret scan, 253-commit history
scan and `git diff --check`. Independent Standards and Spec re-reviews both passed with zero P0–P2.
No paid provider call, push, merge, deploy or staging mutation.

Ticket 06 implementation complete: overview now derives `adaptive-retention-v1` from the existing
owner-bound Voice Tutor recovery ledger. Due day-1/day-7 checks are reference-only and become the highest
eligible exact session block even after other same-skill weekly planning; no prompt, answer, essay,
transcript or audio is copied. The block and browser launch bind the exact repeat/task IDs and UTC window.
Locked day-7 work is excluded until the same recovery chain has a passed day-1 attempt, including when both
timestamps are already overdue; every exact repeat can occupy at most one block in a composed session.
Their existing repeat POST saves the UUID and consumes the adaptive execution claim in one file mutation or
PostgreSQL transaction, so a same-skill mismatch leaves no orphan attempt. Advance records independent
`scheduled_review` evidence only after one shared validator checks owner, block, launch, exact repeat/task/
window, skill/module and claim timing. The same exact attempt is recoverable after a lost response. An already owed repeat remains
available after Premium expires because it makes no new Voice/AI call.

The profile persists a server-derived critical-window expiry. Equal evidence watermarks may only advance
due state monotonically; an expiring owner/profile-bound window grants a narrow plan-stability bypass to its
exact skill/module, while unrelated allocations stay within ten points and repository reconstruction rejects
invented scope. Re-diagnostic scheduling uses 28/35/42-day cadence from confidence and independent coverage;
the progress screen presents the scheduled short refresh even when no run is active, while fresh adequate
independent evidence is not forced through an immediate diagnostic.

Historical access model (superseded by Reading 2.0 ticket 01): access was explicit as free/base/Premium. Preview, replacement, start/replay, bind and advance enforce current
Premium for deep Writing/Speaking; the existing Voice Tutor session boundary continues to enforce Premium for live handoff.
The new Premium-only orientation uses only independently established skills, returns insufficient evidence
when coverage is sparse and is labelled approximate and non-official for both CEFR and IELTS. Migration 037,
OpenAPI/schema/retention documentation and file/PostgreSQL persistence share the same minimized contract.

Final frozen-result gates: full suite 647 pass plus 12 expected no-URL PostgreSQL skips (659 total);
disposable PostgreSQL 12/12 with migrations 001–037 and cleanup; adaptive Chromium E2E passed on an
isolated rerun after one initial response-wait timeout, with no product-code change; lint/check, 17-asset
frontend build, 409-file secret scan, 254-commit history scan and `git diff --check` pass. Independent
Standards and Spec final reviews both passed with zero P0–P2. No paid provider call, push, merge, deploy or
staging mutation.

The next Ticket 07 paragraphs are retained as implementation history. Their Free demo entry is no
longer a current product promise: the learning shell now requires a server-confirmed active subscription.
Legacy `commercial_scope=free_demo` values remain historical persistence data, not a client access bypass.

Ticket 07 implementation complete: the public adaptive experience now has dashboard/profile entry,
goal editing, confidence-labelled forecast and weekly allocation, understandable feasibility choices,
15–120 minute session controls and a completion summary. Free receives one persisted 15-minute demo
session and one short diagnostic; Base receives the continuous plan and arbitrary valid durations;
Premium adds deep diagnostics, detailed evidence reports, Writing/Speaking depth and explicitly
approximate, non-official CEFR/IELTS orientation. Migration 038 persists immutable
`commercial_scope=free_demo|base|premium`, and every preview/create/current/replace/start/advance/finish,
diagnostic and report boundary is enforced server-side with file/PostgreSQL parity. A previously created
Free demo remains completable after usage is recorded, while a second preview/create is denied.

The unstarted-session control exposes one shared replacement-or-exclusion allowance. Both operations
preserve duration and block identity, choose another eligible server-owned activity, persist an explicit
bounded reason and remain idempotent under races. The UI has a visible associated reason label, restores
focus after replacement/exclusion, focuses the next diagnostic answer or result heading, preserves deep
diagnostic depth on an expired Premium restart, meets computed contrast against inherited backgrounds and
honours reduced motion. Real Chromium covers both actions, keyboard navigation, diagnostic completion,
deep restart, production-wired Free create/current/start/advance/finish and denial of a second demo.

Final gates: Ticket 07 focused tests 34/34; full suite 665/665; disposable PostgreSQL 12/12 with migrations
001–038 and cleanup; adaptive Chromium E2E; lint/check; 17-asset frontend build; 413-file secret scan;
255-commit history scan; and `git diff --check`. Independent Standards and Spec final reviews both passed
with zero P0–P2. The local PostgreSQL runner printed `postgres Pulling`/`postgres Pulled` for its disposable
`postgres:17-alpine` test image; no application provider or paid API was called. No push, merge, deploy or
staging mutation was performed.

Ticket 08 implementation complete: the whole adaptive feature now has a reproducible local release
tracer for new and existing learners, unrealistic-goal choices, one replacement or exclusion,
Free/Base/Premium boundaries, real task handoff and completion, updated profile/plan/report and an
owner-bound 24-hour offline overview that is strictly read-only. The rollout flag hides both entry
points and the plan by default. Initial diagnostic insufficiency blocks first-session creation on the
server, while the 28/35/42-day refresh remains a non-blocking recommendation. Diagnostic evidence is
deduplicated across short/deep catalogs by stable task family; repeated and surrogate no-audio or
non-productive probes remain assisted and cannot establish mastery.

`adaptive-metrics-v1` exposes fixed-cardinality, PII-free aggregates over an explicit rolling 90-day
window. File and PostgreSQL stores share the same denominators; PostgreSQL uses bounded aggregate SQL
with time predicates and migration 039 indexes instead of materializing lifetime rows. Sample-gated
alerts, the adaptive operations runbook and the local release-evidence file record rollout, rollback,
incident and owner-only gates.

Final frozen-result gates: adaptive 121/121; full suite 677 total (665 pass, 12 expected skips, 0 fail);
PostgreSQL 12/12 with migrations 001–039 and cleanup; adaptive Chromium E2E; two consecutive generic
Chromium E2E runs; performance LCP 160 ms, CLS 0, INP 112 ms, first-load JS 82.3 KB, overview 119 ms
and preview 61 ms; lint/check; 17-asset frontend build; staged 423-file secret scan; 256-commit history
scan; and staged diff check. Independent whole-feature Standards and Spec final reviews passed with
zero P0–P2. No paid provider call, push, merge, deploy or staging mutation was performed.

---

# Прогресс — честные экраны и единая история обучения

Спека: [.scratch/learning-evidence-foundation/spec.md](.scratch/learning-evidence-foundation/spec.md)
Тикеты: [.scratch/learning-evidence-foundation/issues/](.scratch/learning-evidence-foundation/issues/)
Ветка: `feature/adaptive-learning-plan`

| № | Что даёт | Статус |
|---|---|---|
| 01 | Честный экран пробника, скрытые фиктивные достижения и очищенный legacy-прогресс | done |
| 02 | Рабочие настройки класса, цели и обычной длительности занятия | done |
| 03 | Единая запись учебной активности и подключённая грамматика | done |
| 04 | Результаты чтения и аудирования в индивидуальном плане | done |
| 05 | Сводка прогресса из реальных учебных свидетельств и выпускной контур | done |

Тикет 02 закрыт: owner-bound progress-модуль хранит класс 8–11 либо честное «не указан» и обычную
длительность 15–120 минут с шагом 5; значение по умолчанию — 30 минут. Существующая офлайн-очередь
синхронизирует модуль только для его владельца; явное сохранение сразу пишет durable owner-bound
очередь. Конструктор Base/Premium начинает с сохранённой длительности, а Free честно показывает
server-authoritative лимит 15 минут, не теряя предпочтение. Профиль читает балльную цель из adaptive goal и открывает единый редактор,
неработающие настройки скрыты. ADR 0002 фиксирует будущие VK ID-only вход учеников, отдельный
admin/staging-контур и платёжный adapter с выбором Robokassa либо аналога перед реализацией. Целевые
тесты 67/67, полный набор 728 (713 pass, 15 штатных skip), lint/check, 16-asset frontend build и adaptive
Chromium E2E прошли; платных вызовов, OAuth/оплаты, новых секретов, push и deploy не было.

Тикет 03 закрыт: единый клиентский recorder выбирает ровно один путь — точный active adaptive block
завершается через прежний execution claim, отсутствие блока создаёт одну owner-bound offline module
attempt, а несовпадающий active block блокирует ordinary evidence. Все 20 тематических подходов,
раздельные повторения forms/transformations и экзамен 19–24 передают стабильный UUID, точный activity
ID, score/max и duration. Смешанная review-сессия создаёт максимум по одному distinct skill slice для
forms и transformations с раздельными score/max, фактическими source/help-сигналами и детерминированным
делением duration, сумма которого равна времени сессии; metadata ограничены перечисленными примитивными
mode/source/help-полями без учебного содержания. Обычные результаты остаются `client_reported`.
Целевые recorder/grammar тесты 10/10 и расширенный регрессионный набор 98/98; полный набор 735
(720 pass, 15 штатных skip), lint/check, 16-asset frontend build и adaptive Chromium E2E
прошли; платных вызовов, push и deploy не было.

Тикет 04 закрыт: все завершения чтения и аудирования — заголовки, детальные вопросы, пропуски,
сопоставление говорящих, True/False/Not stated, интервью и оба комбинированных экзамена — публикуют
результат через единый recorder. Обычная практика создаёт только owner-bound offline attempt, точный
active adaptive block использует только execution claim, а несовпадение блокируется без ordinary fallback.
Комбинированный экзамен создаёт максимум по одному gist/detail slice с точными score/max; общая
фактическая длительность детерминированно делится пропорционально максимумам и сохраняется без потерь.
Единая activity-ID taxonomy теперь включает пропуски чтения и True/False/Not stated, а source/help/mode
остаются allowlisted примитивами без вопросов, ответов, транскриптов или аудио. Целевые тесты 40/40,
полный набор 744 (729 pass, 15 штатных skip), lint/check, 16-asset frontend build, релевантный Chromium
E2E, оба secret scan и staged diff-check прошли. Независимые Standards и Spec re-review завершились с
нулём P0–P3; платных вызовов, push и deploy не было.

Тикет 05 закрыт: экран прогресса читает существующий owner-bound adaptive evidence profile и всегда
показывает шесть разделов с честными unobserved/preliminary/established состояниями, внутренним
«освоением», уверенностью, неопределённостью и числом свидетельств; CEFR/IELTS остаются только в прежнем
Premium-отчёте. Authenticated overview доступен для read-only сводки независимо от rollout плана, но при
выключенном флаге не возвращает goal/plan и не открывает коммерческие маршруты. Existing owner cache
показывается offline только как сохранённая, возможно несвежая копия с timestamp. Ordinary API теперь
отклоняет Writing/Speaking с `SERVER_ASSESSMENT_REQUIRED`, единая evidence policy и ревизия профиля 2
исключают legacy client-reported productive строки, сохраняя existing server-assessed AI reviews.
Focused проверки 69/69; полный набор 751 (736 pass, 15 штатных PostgreSQL skip), lint/check, 16-asset
frontend build, progress (дважды), reading/listening, vocabulary и adaptive Chromium E2E, оба secret scan
и staged diff-check прошли. Финальные независимые Standards и Spec re-review завершились с нулём P0–P3;
платных вызовов, push, deploy и изменения rollout flags не было.
# Прогресс — «Аудирование 2.0», пилот из 60 записей

Спека: [.scratch/listening-2-pilot/spec.md](.scratch/listening-2-pilot/spec.md)
Тикеты: [.scratch/listening-2-pilot/issues/](.scratch/listening-2-pilot/issues/)
Ветка: `feature/adaptive-learning-plan`

| № | Что даёт | Статус |
|---|---|---|
| 01 | 20 экзаменационных комплектов сопоставления и контракт каталога | done |
| 02 | 20 полноразмерных True/False/Not stated | done |
| 03 | 20 интервью заданий 3–9 и полный каталог из 60 | done |
| 04 | Статические MP3 и безопасный dry-run/генератор xAI TTS | done |
| 05 | Умная ротация, связь с индивидуальным планом и выпускной контур | done |

Тикет 05 закрыт: owner-bound история хранит только ограниченные метаданные id/revision и помощи;
обычные и комбинированные listening-сессии сначала выбирают невстречавшиеся комплекты, исключают
немедленный повтор при наличии альтернативы, затем возвращают просроченные и слабые. Замедление,
лишние прослушивания, synth fallback и повтор после раскрытого транскрипта честно передаются как
assisted metadata в единственный adaptive recorder. Каталог работает через существующий offline runtime
cache, а MP3 сохраняют текущий безопасный Range-контур. Полный набор 795 (780 pass, 15 штатных
PostgreSQL skip), lint/check, frontend build, полный desktop, reading/listening и adaptive Chromium E2E, secret/history scan и
безопасный audio dry-run прошли. Dry-run подтвердил 60 комплектов, 400 ожидаемо отсутствующих assets,
56 914 символов и оценку $0.853710; фактических network/xAI/paid calls, MP3-записей, push и deploy не было.

Тикет 02 закрыт: общий каталог теперь содержит 20 оригинальных matching- и 20 оригинальных
True/False/Not stated-комплектов. Все задания 2 имеют по семь утверждений, включают True, False и
Not stated, дословное доказательство и русское объяснение; экран загружает каталог до старта попытки,
считает 7 баллов из фактического комплекта и не показывает транскрипт или разбор до проверки.
Результат остаётся в существующем listening detail-контуре без второй adaptive-попытки. Целевые тесты
23/23, полный набор 764 (749 pass, 15 штатных skip), lint/check, frontend build и Chromium E2E прошли;
сетевых и платных вызовов, push и deploy не было.

Тикет 03 закрыт: единый `listening-pilot-v1` содержит ровно 60 полностью оригинальных комплектов с
распределением 20/20/20. Добавлены 20 интервью B1–B2 по семь вопросов и четыре уникальных варианта;
все 140 ключей имеют стабильный voice-tutor item id, единственный дословный фрагмент сценария и русское
объяснение. Обычная тренировка и комбинированный экзамен используют фактические размеры 6/7/7,
публикуют interview как listening detail и регистрируют ошибки в существующем голосовом контуре.
Методическая проверка подтвердила уникальность 140 вопросов, цитат и наборов вариантов и однозначность
каждого ключа. Целевые тесты, полный набор 771 (756 pass, 15 штатных PostgreSQL skip), lint/check,
frontend build и Chromium E2E прошли; сетевых и платных вызовов, push и deploy не было.

Тикет 04 закрыт: безопасная команда по умолчанию валидирует все 60 комплектов и строит 400
role-aware immutable MP3-путей, не вызывая `fetch` и не записывая аудио. Чистый dry-run насчитал
56 914 фактически отправляемых символов и $0.853710 при конфигурируемой ставке $15 за миллион;
все 400 assets пока честно отмечены отсутствующими. Реальная генерация требует одновременно
`--paid`, точное `--confirm-paid=I_ACCEPT_XAI_TTS_CHARGES` и `XAI_API_KEY` из окружения. Конвейер
проверяет безопасный путь, MIME `audio/mpeg`, размер, MP3-сигнатуру и SHA-256, публикует asset и
manifest атомарно, восстанавливается после обрыва и не оплачивает повторно валидные файлы.
HTTP adapter использует актуальный xAI TTS-контракт: lowercase voice id, обязательный `language: en`
и явный MP3 24 kHz / 128 kbps; отдельного `en-GB` провайдер не предлагает, поэтому британское
произношение остаётся обязательной ручной проверкой голосов до платного запуска. Браузер и генератор
разделяют один manifest-контракт. Браузер предпочитает готовую последовательность сегментов из
manifest; stop отменяет даже ожидающую загрузку, error fallback проверен, отсутствие файла и slow mode
явно показывают тренировочную assisted-озвучку. Service worker получает полный `200` MP3, не пытается
кэшировать `206` и отвечает на Range из полного кэша офлайн. Целевые проверки конвейера,
проигрывателя и offline Range 29/29, полный набор 783 (768 pass, 15 штатных PostgreSQL skip),
lint/check, frontend build, reading/listening Chromium E2E, secret scan и diff-check прошли. Реальных
сетевых/xAI/платных вызовов, push и deploy не было.

Подтверждённый владельцем платный запуск xAI TTS выполнен 2026-08-05 из изолированного каталога на
VPS без изменения работающего staging. Созданы все 400 MP3 для 60 комплектов (56 914 символов,
расчётная стоимость $0.853710), manifest обновлён атомарно. Server-side и локальный dry-run после
импорта дали `requests=0`, `missing_assets=0`; SHA-256 скачанного 52 MB архива совпал на обеих
машинах. Локально полный набор остался зелёным: 795 тестов, 780 pass, 15 штатных PostgreSQL skip,
0 fail. Финальная frontend-сборка содержит 419 проверенных assets, но 400 MP3 намеренно не входят
в стартовый APP_SHELL: оболочка кеширует только manifest, а Range-aware runtime cache получает
аудио по требованию. Lint/check и secret scan прошли; `XAI_API_KEY` не выводился и не сохранялся.
До deploy остаются ручная проверка голосов, отдельный commit с бинарными assets и owner-approved
push/deploy.

Ticket Speaking 2.0 / 09 прошёл финальное укрепление: adaptive bind принимает только evidence ровно
назначенного Speaking `skillId`, а focused word/phoneme — только точный подтверждённый outcome. Все
Premium-цели и динамика сегментированы по `en-GB`/`en-US`. Все writers adaptive evidence и операции
Premium entitlement разделяют owner serialization, поэтому устаревший профиль не перезаписывает новое
свидетельство, а после завершённого отзыва Premium не создаётся целевая Speaking-сессия. Проверки:
95/95 focused, полный набор 1187 total (1159 pass, 28 PostgreSQL skip), disposable PostgreSQL 001–050
и 28/28, lint/check, frontend build 482 assets, adaptive/full Speaking/pronunciation E2E и оба secret scan.
Платных вызовов, push и deploy не было.

Повторный review Ticket Speaking 2.0 / 09 закрыл nullable acoustics и активную локаль профиля.
Отсутствующая точность Azure теперь остаётся `null` на всём пути и не превращается в ложный 0%, mastery
или фонетическую цель. Premium report и целевая выдача используют только текущую каноническую
`en-GB`/`en-US`; после ручной смены профиля старый target pointer атомарно отклоняется с `409` в file и
PostgreSQL, а новая сессия получает локаль новой цели. Проверки: focused 58/58, полный набор 1190 total
(1162 pass, 28 PostgreSQL skip, 0 fail), disposable PostgreSQL 001–050 и 28/28, lint/check, frontend
build 482 assets, HTTP smoke, adaptive/full Speaking/pronunciation E2E и оба secret scan. Временные
PostgreSQL-ресурсы удалены; provider-вызовов, push и deploy не было.

Финальный review Ticket Speaking 2.0 / 09 закрыл строгий числовой контракт Azure, отдельные
`unexpected_break`/`missing_break`, атомарный Learning report и устойчивую привязку Voice Tutor.
Отсутствующие/строковые confidence и timing не создают ложную беглость, ноль или mastery. Паузы видны
в Base/Premium, но не являются ошибками произношения и не меняют балл ФИПИ. File и PostgreSQL читают
attempts, квоту/тариф и акцент одним owner-serialized снимком; гонки смены акцента, поздней помощи и
отзыва Premium проверены детерминированно. Voice Tutor использует bounded criterion и matching attempt
summary из надёжной попытки, а не данные более новой technical/assisted попытки. Проверки: focused
Speaking/UI 84/84; полный набор 1195 total (1167 pass, 28 штатных PostgreSQL skip, 0 fail); disposable
PostgreSQL 001–050 и 28/28; lint/check; frontend build 482 assets; полный и adaptive Chromium E2E; оба
secret scan и diff-check. Временные PostgreSQL-ресурсы удалены; provider-вызовов, push и deploy не было.

Финальная граница полноты Azure для Ticket Speaking 2.0 / 09 закрыта fail-closed. Потерянный segment,
`NBest`, confidence, обязательный факт слова, превышение 200 сегментов или 500 слов больше не может
дать успешную оценку или mastery. Временные метки каждого слова строго сверяются с разобранной
длительностью WAV и допуском 50 мс до расчёта беглости, ФИПИ и публичного отчёта. Pause-аннотации
сохраняют слово в accuracy/completeness/fluency, но не считаются ошибками ФИПИ и не меняют балл.
Явный `pauseAnalysisAvailable` проходит от provider через storage/report/OpenAPI/UI: `en-US` показывает
доступный нулевой результат, `en-GB` — неподдерживаемый показатель, а Premium-динамика различает ноль
и отсутствие измерения. Проверки: focused 84/84; полный набор 1200 total (1172 pass, 28 штатных
PostgreSQL skip, 0 fail); disposable PostgreSQL 001–050 и 28/28; lint/check; frontend build 482 assets;
полный и adaptive Chromium E2E; оба secret scan и diff-check. Временные PostgreSQL-ресурсы удалены;
реальных provider-вызовов, push и deploy не было.

Финальная граница Ticket Speaking 2.0 / 09 закрыта по результатам повторного аудита. Azure continuous
recognition теперь fail-closed обрабатывает смешанный valid + `NoMatch`; поддержка пауз/просодии считается
доступной только после успешного `enableProsodyAssessment()`, сохраняя честную разницу между нулём и
отсутствием метрики. Миграция 051 проводит evidence fingerprint через profile DTO, file/PostgreSQL,
public projection и export. Owner-serialized CAS по содержимому позволяет same-count/same-time помощи
понизить устаревшее independent mastery и не даёт старому снимку восстановить его. Проверки: focused
117/117; полный набор 1203 total (1174 pass, 29 штатных PostgreSQL skip, 0 fail); disposable PostgreSQL
001–051 и 29/29; lint/check; frontend build 482 assets; полный и adaptive Chromium E2E; secret scan
1082 файлов и history scan 298 commits; diff-check. Временные PostgreSQL-ресурсы удалены; реальных
provider/платных вызовов, push и deploy не было. Код заморожен для Standards → Spec review.

Повторный аудит Ticket Speaking 2.0 / 09 закрыл последнюю сквозную границу между evidence-профилем и
сохранённым персональным планом. Миграция 052 добавляет nullable SHA-256 content fingerprint в ревизии
плана; новые планы связывают с ним input fingerprint, ordering/replay, authoritative validation, DTO,
file/PostgreSQL storage и export. Поэтому same-count/same-time поздняя отметка помощи создаёт новую
согласованную ревизию и распределение, а не возвращает устаревший current plan. Legacy null читается и
обновляется; удаление аккаунта каскадно удаляет историю. HTTP-регрессия зелёная в file и реальном
PostgreSQL. Проверки: focused 72/72; полный набор 1205 total (1175 pass, 30 штатных PostgreSQL skip,
0 fail); disposable PostgreSQL 001–052 и 30/30; lint/check; frontend build 482 assets; полный и adaptive
Chromium E2E; secret scan 1082 файлов, history scan 298 commits и diff-check. Временные PostgreSQL-
ресурсы удалены; реальных provider/платных вызовов, push и deploy не было. Код заморожен для свежих
Standards → Spec review.

Финальный interleaving-аудит Ticket Speaking 2.0 / 09 перевёл evidence watermark на одну каноническую
eligible-source проекцию: calculation revision, version, count, latest time и SHA-256 fingerprint больше
не могут расходиться, а timestamps `Date`/ISO/epoch milliseconds/seconds дают одинаковую identity в
file и PostgreSQL. Сохранение плана теперь до replay/insert повторно сверяет persisted profile и
candidate с текущим полным evidence-вектором внутри owner queue/transaction. Если помощь появилась
после сохранения профиля, route ограниченно повторяет весь overview и возвращает согласованные
пониженный профиль и новую ревизию плана. Детерминированные file и live PostgreSQL HTTP hooks зелёные.
Проверки: focused diagnostic/adaptive/plan/file 111/111; полный набор 1209 total (1179 pass,
30 штатных PostgreSQL skip, 0 fail); disposable PostgreSQL 001–052 и 30/30; lint/check; frontend build
482 assets; полный и adaptive Chromium E2E; secret scan 1082 файлов, history scan 298 commits и
diff-check. Временные PostgreSQL-ресурсы удалены; provider-вызовов, push и deploy не было. Код
заморожен для свежих Standards → Spec review и единого коммита владельцем родительской задачи.

Последний fail-closed аудит Ticket Speaking 2.0 / 09 запретил неявно превращать повреждённые evidence-
поля в учебный прогресс: score/max принимаются только как конечные числа с положительным максимумом,
а diagnostic/recovery-флаги — только как boolean. File и PostgreSQL одинаково исключают `null`, пустые,
числовые и boolean-похожие строки из mastery и всего watermark-вектора; corrupted JSON покрыт прямыми
регрессиями. Profile CAS выполняет максимум три полных overview-попытки, включая режим без цели и без
плана: временная первая/вторая гонка возвращает согласованный 200, исчерпание — retryable
`409 ADAPTIVE_PROFILE_RETRY_REQUIRED` с `Retry-After: 1`, без смешивания старого профиля с новой
retention/access-проекцией. Проверки: focused 124/124; полный набор 1215 total (1183 pass,
32 штатных PostgreSQL skip, 0 fail); disposable PostgreSQL 001–052 и 32/32; lint/check; frontend build
482 assets; полный и adaptive Chromium E2E; secret scan 1082 tracked файлов, history scan 298 commits,
scan 7 untracked файлов и diff-check. Временные PostgreSQL-ресурсы удалены; provider-вызовов, push и
deploy не было. Код заморожен для свежих Standards → Spec review.

Финальный конкурентный аудит Ticket Speaking 2.0 / 09 закрыт. Premium-depth `start`, exact replay,
`bind-attempt` и `advance` атомарно перечитывают активные base+voice entitlement внутри file owner queue
или PostgreSQL user-lock transaction; завершённый отзыв Premium не может пропустить запись после
route-precheck, а Basic execution сохранён. Azure `monotone` учитывается как произнесённое слово в
completeness/fluency и остаётся видимым событием, но не является ошибкой ФИПИ и не меняет балл задания
1. Все исчерпанные plan-stage conflict/stale исходы после трёх полных overview-попыток унифицированы в
retryable `409 ADAPTIVE_PROFILE_RETRY_REQUIRED` с `Retry-After: 1`; временная первая/вторая гонка даёт
согласованный 200. Проверки: focused RED 80/85 → GREEN 85/85; полный набор 1219 total (1185 pass,
34 штатных PostgreSQL skip, 0 fail); disposable PostgreSQL 001–052 и 34/34; lint/check; frontend build
482 assets; полный и adaptive Chromium E2E; secret scan 1082 tracked файлов, history scan 298 commits
и diff-check. Временные PostgreSQL-ресурсы удалены; provider-вызовов, commit, push и deploy не было.
Код заморожен для свежих Standards → Spec review.

Final14 закрыл authority времени, start/replacement interleaving и момент закрытия замены. Premium-depth
`start`, exact start/advance replay, `bind-attempt` и `advance` используют effective time только после file
owner queue или PostgreSQL user `FOR UPDATE` (`clock_timestamp()`), а не route `candidate.now`. Start до
claim атомарно сверяет locked session revision/replacement и launch fingerprint; replacement-wins даёт
409 вместо старого ответа с новым claim. После local pending/start, любого claim, `started_at`,
`in_progress`/`completed`, execution revision или event новый replace и exact replay fail-closed отвечают
`409 ADAPTIVE_SESSION_REPLACEMENT_LOCKED`; UI скрывает контролы уже при pending.

TDD RED: effective-time file 5/6, stale-launch 6/7, replacement/UI 20/23; GREEN file/API/runtime 23/23.
Полный набор — 1223 total (1189 pass, 34 штатных PostgreSQL skip, 0 fail); disposable PostgreSQL применил
001–052 и прошёл 34/34, после чего container/network/volume удалены, Docker Desktop остановлен. Реальных
provider/платных вызовов, commit, push и deploy не было. `lint`, `check` (348 JS), frontend build (482
assets), полный и adaptive Chromium E2E, secret scan 1082 tracked файлов, history scan 298 commits,
отдельный scan 7 untracked файлов и `git diff --check` зелёные. Код заморожен для свежих
последовательных Standards → Spec review.

Final16 закрыл последнюю authorization-гонку Speaking learning loop. Learning report и targeted
assignment после file owner queue / PostgreSQL user `FOR UPDATE` сначала перечитывают активную Base-
подписку по свежему authority-времени и только затем определяют Premium. Поэтому Base expiry после
route-precheck даёт `403 SUBSCRIPTION_REQUIRED` без report payload и без новой targeted session, тогда
как отзыв только Premium сохраняет Base report и прежний stale-pointer 409. TDD: file RED 200→403 и
409→403, затем learning API 11/11; живой disposable PostgreSQL 001–052 — 37/37 с двумя lock-race
сценариями и неизменившимся session count. Полный набор — 1237 total (1200 pass, 37 штатных PostgreSQL
skip, 0 fail); lint/check (348 JS), frontend build 482 assets, полный и adaptive Chromium E2E зелёные.
Provider/платных вызовов, commit, push и deploy не было; код заморожен для свежих Standards → Spec
review.

Final17 закрывает последний продуктовый разрыв Voice Tutor: максимальный официальный балл больше не скрывает
конкретную надёжную ошибку произношения. Если все критерии ФИПИ максимальны, Premium report выбирает самый слабый
точный word/phoneme ниже 80, выдаёт bounded server-owned pointer с attempt/task/accent, стабильным ref/label,
кратким evidence, observation time и 30-дневным expiry. Любая потеря официального критерия по-прежнему имеет
приоритет. Launch/replay заново строят капсулу из owner-bound attempt, сверяют точный ref и expiry; устаревший
указатель получает bounded 409. Капсула имеет `lost_points: 0`, не меняет официальный score/mastery и хранится
только как существующий `voice-tutor-reference-v1`; UI показывает точный label и не ставит прежний `got < max`
барьер. File route, публичный report, capsule/replay и UI закреплены TDD; OpenAPI и retention parity обновлены.
Focused-набор прошёл 56/56; полный `npm test` — 1241 total (1203 pass, 38 штатных PostgreSQL skip,
0 fail); disposable PostgreSQL применил миграции 001–052 и прошёл 38/38, включая reserve/rebuild/export/delete
новой капсулы, после чего container/network/volume удалены. `lint`, `check` (348 JS), frontend build (482 assets),
полный и adaptive Chromium E2E, secret/history scans и `git diff --check` зелёные. Provider/платных вызовов,
commit, push и deploy не было.

Final19 закрыл explicit fallback endpoint, fresh-create catch и rollback parity file storage. `/fallback` теперь
внутри file owner queue либо PostgreSQL user `FOR UPDATE` берёт свежее authority-время, повторно требует активные
Base+Premium и до любых status/billing/outcome/delivery/nonce изменений блокирует и пересобирает exact
pronunciation attempt/ref/assistance/mastery/30-day-expiry pointer. Revoke, Base expiry, assistance/ref drift и
точная граница expiry возвращают 403/409 без изменения сессии и без text AI. Fresh-create ticket catch переводит
сессию в text/local только для явного `VOICE_TUTOR_PROVIDER_UNAVAILABLE`; authorization, stale/expired pointer,
session integrity/expiry/conflict ошибки сохраняют свой код. File reserve восстанавливает полный in-memory snapshot
после любого throw, поэтому expiry reconciliation не может протечь в следующую persistence; PostgreSQL даёт ту же
гарантию rollback транзакции. Проверки: initial TDD RED 16 total / 11 pass / 5 intended fail и отдельный
integrity-classification RED 18/19; GREEN 19/19 file/API, 53/53 focused Voice Tutor, live PostgreSQL 41/41;
полный набор 1259 total (1218 pass, 41 штатный PostgreSQL skip, 0 fail),
lint/check (348 JS), frontend build 482 assets, full Chromium/adaptive E2E, оба secret scan и `git diff --check`.
Provider/платных вызовов, commit, push и deploy не было; дерево заморожено для свежего Standards → Spec review.

Final18 закрыл две последние атомарные гонки Voice Tutor. Create, exact replay, realtime-ticket issue/reissue и
text/local recovery теперь после file owner queue либо PostgreSQL user `FOR UPDATE` берут свежее authority-время,
повторно требуют активные Base+Premium и только затем возвращают сессию или меняют ticket/nonce. Поэтому revoke
или Base expiry, завершившиеся во время ожидания lock, дают 403 без ротации credentials. Для pronunciation-error
капсулы та же owner-мутация заново блокирует исходную Speaking-попытку и сверяет assistance, mastery, точный
word/phoneme ref и 30-дневный expiry; route-built capsule больше не считается authority, а assistance-wins,
ref drift и точная граница expiry дают bounded 409 до создания сессии/ticket. Criterion pointer, idempotency,
export/delete и retention-семантика сохранены. TDD RED зафиксировал file replay/recovery/assistance и две live-PG
гонки; GREEN: focused 63/63, весь Voice Tutor 90/90, полный набор 1251 total (1210 pass, 41 штатный PostgreSQL skip,
0 fail), disposable PostgreSQL 001–052 и 41/41. `lint`, `check` (348 JS), frontend build (482 assets), полный и
adaptive Chromium E2E, secret scan 1082 tracked файлов, history scan 298 commits, scan 7 untracked файлов и
`git diff --check` зелёные. Временные PostgreSQL-ресурсы удалены; provider/платных вызовов, commit, push и deploy
не было. Код заморожен для свежих последовательных Standards → Spec review и единственного родительского коммита.

---
