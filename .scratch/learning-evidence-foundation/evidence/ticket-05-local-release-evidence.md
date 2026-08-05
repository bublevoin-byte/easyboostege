# Ticket 05 — локальное release evidence

- Дата: **5 августа 2026 года**.
- База diff: `6a138df1fa086de433dc047918d726258f647d44`.
- Режим: локальная разработка и проверки; без push, deploy, paid API, изменения rollout flag,
  staging/production mutations или внешней публикации.

Финальный SHA создаётся одним локальным commit после завершения ворот и независимого review;
самоссылочный SHA намеренно не записывается внутрь commit.

## Проверяемый пользовательский путь

Real Chromium при `ADAPTIVE_LEARNING_ENABLED=false` выполняет ordinary completion чтения с клавиатуры,
наблюдает один owner-bound `client_reported` attempt, затем authenticated authoritative overview и
обновлённую six-module summary. Сводка показывает preliminary освоение, confidence/uncertainty и
evidence count, а другой owner не получает эту попытку. Отдельный owner с существующим независимым
server evidence показывает текстово и визуально отличное established-состояние.

Пустой профиль показывает «Недостаточно занятий для оценки» без 0% и официального уровня. Offline
fallback читает существующий owner-bound overview cache только read-only и имеет явную метку
«Сохранённая копия · данные могут быть не свежими» с timestamp. Online и cached состояния не
смешиваются. Writing/Speaking продолжают поступать только из существующих completed server-assessed
attempts; новый клиентский duplicate path не добавлен.

## Локальные ворота

На Windows npm запускался через `npm.cmd`.

| Проверка | Фактический результат |
|---|---|
| Focused unit/integration: frontend summary, recorder, reading/listening, adaptive profile/operations/diagnostic и Writing/Speaking server review | `69/69`, без skip/fail |
| Полный `npm.cmd test` | `751` tests: `736` pass, `15` штатных skip без PostgreSQL URL, `0` fail |
| `npm.cmd run lint` | успешно |
| `npm.cmd run check` | `247` JavaScript-файлов; `181` inline handlers (`21` markup, `160` runtime), все `126` имён разрешены |
| `npm.cmd run build:frontend` | `16` проверенных assets; shell `327.6 KB` JavaScript; `4` lazy chunks |
| `npm.cmd run test:e2e:progress` | реальный Chromium успешно два последовательных раза на финальном product-коде |
| `npm.cmd run test:e2e:evidence` | reading/listening evidence Chromium успешно |
| `npm.cmd run test:e2e:vocabulary` | существующий vocabulary Chromium успешно после вынесения общего harness |
| `npm.cmd run test:e2e:adaptive` | diagnostic, ordinary client module, exam launch и exact server-owned Writing execution успешно |
| `npm.cmd run security:secrets` | успешно, проверено `462` tracked files |
| `npm.cmd run security:history` | успешно, проверено `269` существующих commits до финального commit |
| `git diff --cached --check` | успешно |

Первый полный прогон после поднятия ревизии профиля выявил три устаревших тестовых ожидания старой
ревизии/HTTP-кода; соответствующие contract helpers переведены на динамическую ревизию и явный
`SERVER_ASSESSMENT_REQUIRED`, после чего полный набор прошёл без ошибок. Дополнительный adaptive E2E
выявил старую фикстуру с клиентскими Writing/Speaking attempts; фикстура удалена, tracer повторно прошёл.

PostgreSQL contract отдельно не запускался: persistence и миграции не менялись, а полный набор честно
показывает `15` штатных skip без PostgreSQL URL. Performance tracer не запускался: first-load budget и
lazy-loading boundary не менялись; frontend build зафиксировал фактический shell budget и lazy chunks.

## Независимый review

Первый Standards review не нашёл документированных нарушений и указал три P3 judgment calls: общий E2E
harness, единый каталог названий модулей и честное имя загрузчика overview. Все три устранены. Первый Spec
review подтвердил остальные контракты и выявил P1: ordinary API допускал поддельные client-reported
Writing/Speaking attempts. API теперь отклоняет их, а ревизия профиля 2 defense-in-depth исключает legacy
строки до watermark/расчёта, сохраняя существующие server-assessed reviews. Последний P3 устранил
дублирование этой policy между API и профилем: оба слоя используют единый immutable
`requiresServerAssessment()` contract. Финальные независимые Standards и Spec re-review завершились с
нулём P0–P3 по полностью staged кандидату.

## Границы доказательства

Evidence доказывает локальный file-backend/browser contract, но не разрешает production. Вне scope
остаются полный пробный экзамен, достижения, Listening 2.0, VK ID, payment provider, push, deploy и
изменение feature flags. Коммерческие server boundaries plan/report/session не изменены.
