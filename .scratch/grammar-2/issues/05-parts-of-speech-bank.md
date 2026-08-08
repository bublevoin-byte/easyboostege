# 05 — Активный банк частей речи

Status: ready-for-agent
Blocked by: 03 — Активный runner
Spec: `.scratch/grammar-2/spec.md#implementation-decisions`

## Что сделать

Расширить степени сравнения, местоимения, числительные, множественное число, -ing/-ed adjectives и наречия до полноценной четырёхуровневой тренировки с устойчивыми ID, объяснениями и точной работой над формой/согласованием.

## Границы

- Входят шесть названных тем, 144 задания, irregular forms и targeted error focus.
- Не входят времена, глагольные конструкции, служебные слова и mixed/adaptive orchestration.

## Файлы

- `public/grammar-catalog-content.js`, `public/grammar-catalog.js` — контент и coverage.
- `public/modules/grammar.js`, `public/screens/grammar.js` — общий runner и targeted result.
- `test/`, `e2e/` — catalog/accessibility/regression contracts.

## Definition of Done

- [ ] Шесть тем содержат минимум 144 уникальных задания, по 6 каждого типа на тему.
- [ ] Irregular forms и допустимые варианты явно перечислены и автоматически проверяются.
- [ ] Correction/transform требуют активного восстановления, а не выбора из тех же ответов.
- [ ] Слабость сохраняется на уровне темы и error code и попадает в следующий targeted set.
- [ ] Coverage, accessibility и regression tests проходят.
- [ ] `npm test`, `npm run lint` и `npm run check` проходят; один коммит на тикет.
