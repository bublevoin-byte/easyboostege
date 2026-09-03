# 01 — Версионированный эталонный вариант

Status: done
Blocked by: —
Spec: .scratch/ege-full-mock-2026/spec.md#авторский-вариант

## Что сделать

Создать deep domain/catalog module для `ege-en-2026-form-1@1`: связать immutable authored listening 1–9, reading 10–18, grammar 19–24, новый authored lexis/word-formation block 25–36, writing 37–38 и speaking 1–4. Один validator и fingerprint должны доказывать 42 позиции, 82 балла, exact score matrix, полный asset manifest и отсутствие answer keys в public projection.

## Границы

- Входит content registry, exact refs, assessment normalization, property tests и answer-free public projection.
- Допустимо переиспользовать только проверенные immutable entries существующих банков.
- Не входит UI, persistence, API attempt lifecycle, AI-вызовы и второй вариант.
- Материалы ФИПИ не копируются.

## Файлы

- `ege-mock/` — новый domain/catalog/assessment contour.
- `public/` — browser-safe answer-free catalog module/assets.
- `test/` — exhaustive catalog/content/normalization tests.

## Definition of Done

- [x] TDD RED зафиксирован до production-кода.
- [x] Exact form содержит 42 позиции и максимум 82 по матрице спецификации.
- [x] Позиции 25–36 получают проверенный авторский контент и finite accepted answers.
- [x] Public projection не содержит keys/rubrics/private refs; assets имеют digest.
- [x] Старые section catalogs и Grammar version registry не изменены задним числом.
- [x] Focused/full/lint/check/build/security/diff gates зелёные.
- [x] Fresh Standards + Spec review возвращают literal `ZERO_FINDINGS` на одной freeze identity.
- [x] Один локальный commit; push/deploy отсутствуют.
