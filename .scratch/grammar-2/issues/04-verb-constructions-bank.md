# 04 — Активный банк глагольных конструкций

Status: done
Blocked by: 03 — Активный runner
Spec: `.scratch/grammar-2/spec.md#implementation-decisions`

## Что сделать

Дать темам пассива, условий, косвенной речи, модальных глаголов, инфинитива/герундия и вопросов полный четырёхуровневый путь с минимум 24 заданиями на тему и точными ошибками/transfer practice.

## Границы

- Входят шесть названных тем, 144 задания, разметка ошибок и transfer-связей.
- Не входят времена, части речи, служебные слова и смешанный selector.

## Файлы

- `public/grammar-catalog-content.js`, `public/grammar-catalog.js` — контент и coverage.
- `public/modules/grammar.js`, `public/screens/grammar.js` — общий runner без тематических обходов.
- `test/`, `e2e/` — catalog/domain/browser contracts.

## Definition of Done

- [x] Шесть тем содержат минимум 144 уникальных задания, по 6 каждого из четырёх типов на тему.
- [x] Автопроверка принимает только перечисленные эквивалентные ответы и отклоняет ложные варианты.
- [x] Error taxonomy различает construction, auxiliary, agreement, word order, negation/question и confusion pair.
- [x] Каждая тема проходит полный learning/result/due flow без специальных веток экрана.
- [x] Catalog coverage и focused browser/domain tests проходят.
- [x] `npm test`, `npm run lint` и `npm run check` проходят; один коммит на тикет.

## Freeze evidence

- Final independent Standards и Spec review вернули буквальный `ZERO_FINDINGS` на одной frozen identity: base `4baf6b12f068f0d3cf11d2b900de74b3abebaf90`, `18` путей, canonical manifest `1877` bytes, SHA-256 `c3c623390cdf5e8dc21ba0e9af63647fbae118c9ad85669c80b3136bde4266cb`.
- TDD: публичный RED был зафиксирован как `4/4 fail`; первый review-remediation прошёл exact RED `7 total / 4 pass / 3 fail` → GREEN `7/7`, следующий — RED `9 total / 5 pass / 4 fail` → GREEN `9/9`, семантический remediation — RED `10 total / 6 pass / 4 fail` → GREEN `10/10` и self-audit RED `10 total / 7 pass / 3 fail` → GREEN `10/10`, сужение контекста backshift — RED `15 total / 10 pass / 5 fail` → GREEN `15/15`, связывание OpenAPI topic/source/envelope — RED `1/1 fail` → GREEN `1/1`, finite-equivalent gate — RED `15 total / 14 pass / 1 fail` → GREEN `15/15`, первое сужение choice-контекста — RED `15 total / 14 pass / 1 fail` → GREEN `15/15`, а финальное семантическое сужение choice — RED `16 total / 14 pass / 2 fail` → GREEN `16/16`. Расширенный Grammar/catalog/mastery/offline/owner/Voice/security контур прошёл `199/199`.
- Темы `5`, `6`, `7`, `8`, `9`, `18` содержат `192` уникальных активных задания: ровно `32` на тему и `8` каждого из типов `choice`, `input`, `correction`, `transform`. Current `grammar-core-v2` содержит `452` упражнения + `18` exam gaps, fingerprint `fnv1a32:4b03208c`; immutable v1 остаётся `200 + 18`, `fnv1a32:45cee292`.
- Общий Ticket03 runner строит четыре уровня и exact paired transfer без тематических веток; каждая тема проходит clean `16`-outcome session через общий server envelope до `learned` и due review `+1 day`. Exhaustive content gate проверяет все `192` задания, все `48` choices и `144` wrong-option diagnostics, все `72` non-choice semantic pairs, instruction-compliant finite variants и ровно один placeholder каждого input; incomplete level/pair coverage закрывается fail-closed.
- Полный unit/integration suite: `1455 total / 1413 pass / 42` штатных PostgreSQL skip / `0 fail`. Disposable PostgreSQL project `easyboost-postgres-integration-19536` применил миграции `001–052`, прошёл `42/42`, включая общий Grammar mastery persistence/replay/conflict/export/delete contract, затем полностью удалил container/volume/network; независимые post-run filters подтвердили пустые project containers/volumes/networks.
- Lint; check (`369 JS`, `205` handlers, `123` names); build (`482` assets, `546.0 КБ` shell JS, `9` lazy chunks); full и adaptive Chromium E2E; secret scan `1119`; history scan `303`; production audit `0 vulnerabilities` и `git diff --check` зелёные.
- Docker остановлен. Provider/платных вызовов, package install, push и deploy не было. Ticket04 закрыт `done` одним локальным коммитом после двух свежих независимых буквальных `ZERO_FINDINGS`.
