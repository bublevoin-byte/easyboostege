# Ticket 08 — локальное release evidence

- Дата: **4 августа 2026 года**.
- Ветка: `feature/adaptive-learning-plan`.
- Ticket 08 diff base: `428b6beacf4e1df59a6c3c058c211988fefddd3a`.
- Whole-feature review base: `b08a722`.
- Режим: только локальная разработка и проверки; без push, merge, deploy, staging/production
  mutations, production данных, реальных provider-вызовов и ротации секретов.

Финальный Ticket 08 SHA создаётся одним локальным commit после завершения этого evidence и
независимого review. Самоссылочный SHA в содержимое commit намеренно не записывается; точный SHA
передаётся владельцу вместе с результатом `git status`.

## Что доказано

- Real Playwright tracer проходит новый learner path: цель, short diagnostic, честный forecast,
  exact allocation, 15/90-minute preview, start, настоящий vocabulary/listening handoff через
  существующий экран, server attempt, bind/advance/finish и новый authoritative profile/plan/report.
- Тот же tracer покрывает existing learner с ранее завершённой через public API short-диагностикой без лишнего повтора, нереалистичную цель с двумя
  корректными вариантами, replacement/exclusion, offline read-only и восстановление online,
  Free one-shot demo, Base continuous plan и Premium deep/report/Writing path.
- Adaptive UI/API не создаёт внешних AI-вызовов сам по себе. Premium Writing в E2E использует
  только локальный fake HTTP provider; любой внешний HTTPS заблокирован тестом.
- Offline overview — owner-bound публичная проекция до 24 часов/120 000 символов. Mutations
  заблокированы; logout/delete/owner mismatch/expiry/corruption очищают cache fail-closed.
- File и PostgreSQL возвращают один `adaptive-metrics-v1` contract за явное скользящее окно 90 дней.
  Метрики имеют фиксированную cardinality, честные denominator и не содержат PII/IDs/free text;
  PostgreSQL получает четыре aggregate rows с time predicates без lifetime materialization.
- Общие repository/API suites подтверждают owner isolation, exact idempotency replay, CAS/races,
  export/delete и транзакционное связывание evidence.

## Выполненные команды

На Windows npm запускался через `npm.cmd` из каталога `server`.

| Команда | Exit | Результат |
|---|---:|---|
| `node --test "test/adaptive-*.test.js"` | 0 | 121/121 pass, 0 fail, 0 skip. |
| `npm.cmd test` | 0 | 677 total: 665 pass, 0 fail, 12 ожидаемых skip. |
| `npm.cmd run lint` | 0 | ESLint без ошибок. |
| `npm.cmd run check` | 0 | Syntax: 226 JS; 148 inline handlers (18 markup, 130 runtime), 106 имён разрешаются. |
| `npm.cmd run build:frontend` | 0 | 17 verified assets; shell 1 JS file, 264.9 KB uncompressed; 5 lazy chunks. |
| `npm.cmd run security:secrets` (финальный staged candidate) | 0 | 423 staged/tracked files, включая семь новых Ticket 08 files; совпадений нет. |
| `npm.cmd run security:history` | 0 | 256 commits, совпадений нет. |
| `npm.cmd run test:postgres` (sandbox) | 1 | Docker named pipe был недоступен в sandbox; тест не выполнялся и успехом не считается. |
| `npm.cmd run test:postgres` (разрешённый локальный Docker Desktop, финальный повтор) | 0 | PostgreSQL 17; migrations 001–039; 12/12 pass, 0 fail/skip; container/network/volume очищены. Первый прогон после добавления 039 честно обнаружил устаревший expected migration list (11/12), затем contract исправлен; финальный повтор зелёный. Application/provider network calls не выполнялись. |
| `npm.cmd run test:e2e:adaptive` | 0 | Полный adaptive tracer прошёл; production/external HTTPS blocked, AI — local fake only. |
| `npm.cmd run test:e2e` (диагностические прогоны) | 1 | Тест сначала обнаружил, что author CSS переопределял HTML `hidden`, затем выявил незавершённый `waitForResponse` и слишком кратковременные педагогические состояния. Причины исправлены; эти прогоны успехом не считаются. |
| `npm.cmd run test:e2e` (два финальных изолированных повтора) | 0 | Два последовательных чистых прогона после финальных review-fixes: Chromium/desktop critical flows, feature-off entries, offline queue, local fake Voice Tutor и responsive 320–1440px прошли. |
| `npm.cmd run test:e2e:performance` | 0 | LCP 160ms, CLS 0.000, INP 112ms, first JS 82.3KB, AI indicator 42ms, adaptive overview 119ms, adaptive preview 61ms. Все бюджеты пройдены. |
| `git diff --cached --check` | 0 | Полный staged candidate, включая новые файлы: whitespace errors нет; Windows LF→CRLF warnings не являются diff errors. |

Первые RED/diagnostic прогоны в ходе разработки не подменяются финальным результатом: performance
сначала обнаружил styled-label interception у test selector. Независимое review затем обнаружило
нереалистичный existing-user fixture с напрямую выданным trusted module evidence: fixture удалён,
все existing flows теперь создают server-owned diagnostic history только через public API; production
пороги доверия не ослаблялись. Финальный generic E2E дополнительно устранил dangling response promise
и фиксирует кратковременные педагогические состояния через `MutationObserver`, не ослабляя проверки.

## Бюджеты и алерты

- Adaptive overview и 60-minute preview: каждый ≤ 1500ms; локально 119ms и 61ms.
- Alert sample gates: created 20 для start/planned-minute rate, started 10 для completion rate,
  observed day-7 10 для retention. Порог каждой доли по умолчанию 50%.
- Пустой denominator возвращает rate 0; недостаточная выборка не создаёт alert.
- Определения, rollout/rollback и incident response: `docs/ADAPTIVE_LEARNING_OPERATIONS.md`.

## Границы доказательства и owner gates

Это evidence подтверждает локальную готовность к review, но **не разрешает production**. Не выполнены
и остаются за владельцем:

1. принять независимые Standards + Spec review результаты и решение о merge;
2. выполнить push/PR/merge;
3. сделать backup и owner-approved staging migration/rollout;
4. включить `ADAPTIVE_LEARNING_ENABLED` сначала на ограниченном окружении;
5. выполнить ручной staging smoke и наблюдать реальные агрегаты/alerts;
6. отдельно принять решение о production rollout и иметь проверенный rollback.

Локальные browser profiles/fake provider не доказывают production latency, provider billing,
реальную доставку Telegram alerts, physical-device PWA behavior или пользовательскую эффективность.
При owner/isolation/privacy/idempotency/evidence ошибке rollout должен быть остановлен, флаг выключен,
а сохранённые миграции не должны автоматически откатываться.

## Independent whole-feature review

Первые независимые Standards + Spec проходы относительно `b08a722` нашли и остановили release на трёх
P1 и одном P2: плановая повторная диагностика блокировала занятия; deep choices без реального audio или
productive response считались strong evidence; одинаковый short/deep item мог дать два независимых
наблюдения; секрет-скан ещё не видел семь новых unstaged файлов. Исправления выполнены TDD: cadence теперь
отдельно предлагается через `retention.rediagnostic.due`, `needsDiagnostic` остаётся initial-only,
косвенные modality probes assisted, stable `skill_id:item_id` family дедуплицируется между каталогами,
а полный candidate staged до финальных security/diff gates.

Свежие финальные Standards + Spec проходы проверили staged/current candidate относительно `b08a722`.
Оба независимо подтвердили: **P0–P2 замечаний нет**; все прежние findings закрыты. Standards reviewer
дополнительно прогнал 38/38 целевых тестов, Spec reviewer — 45/45; оба подтвердили чистый
`git diff --cached --check`, отсутствие unstaged/untracked файлов и соответствие текущего index.

Остаточные неблокирующие риски: browser existing-user path создаёт реалистичную server-owned short
history через public API, но не имитирует многолетнюю production history; PostgreSQL overview пока
материализует полную owner-bound evidence history при пересчёте. Ограниченный rollout должен наблюдать
latency на старых аккаунтах. Локальные fake-provider/browser проверки по-прежнему не доказывают
production billing, Telegram delivery, physical-device PWA behavior или learner efficacy.

После локального Ticket 08 commit корневая handoff-проверка обнаружила, что заголовки `spec.md` и
`PROGRESS.md` всё ещё называли завершёнными только Tickets 01–07, а issue использовал `complete` вместо
разрешённого tracker-статуса `done`. Это исправлено отдельным documentation-only commit: product-код,
staged candidate и результаты ворот выше не менялись. Исходный commit намеренно не amend-ился, потому
что переписывание Git-истории остаётся отдельным owner gate.
