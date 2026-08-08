# 06 — Активный банк служебных слов

Status: ready-for-agent
Blocked by: 03 — Активный runner
Spec: `.scratch/grammar-2/spec.md#implementation-decisions`

## Что сделать

Расширить артикли, предлоги и союзы/связки до полного четырёхуровневого банка, который проверяет выбор по контексту, исправление и контролируемое преобразование, а не только запоминание маркеров.

## Границы

- Входят три названные темы, 72 задания, нулевой артикль, устойчивые предлоги и синтаксические формы связок.
- Не входят остальные 17 тем и смешанный/adaptive selector.

## Файлы

- `public/grammar-catalog-content.js`, `public/grammar-catalog.js` — контент и coverage.
- `public/modules/grammar.js`, `public/screens/grammar.js` — общий runner и due/error focus.
- `test/`, `e2e/` — catalog/domain/browser contracts.

## Definition of Done

- [ ] Три темы содержат минимум 72 уникальных задания, по 6 каждого типа на тему.
- [ ] Нулевой артикль, устойчивые предлоги и разные синтаксические формы связок покрыты явными ответами.
- [ ] Transfer items меняют контекст и не повторяют исходную строку.
- [ ] Состояние темы, error focus и due review работают через общий runner.
- [ ] Catalog coverage и browser/domain tests проходят.
- [ ] `npm test`, `npm run lint` и `npm run check` проходят; один коммит на тикет.
