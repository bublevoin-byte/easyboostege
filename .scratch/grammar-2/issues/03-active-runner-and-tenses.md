# 03 — Активный runner и полноценные времена

Status: ready-for-agent
Blocked by: 01 — Каталог; 02 — честное освоение
Spec: `.scratch/grammar-2/spec.md#implementation-decisions`

## Что сделать

Запустить новый четырёхуровневый runner на пяти темах времён. Каждая тема получает минимум 24 встроенных задания: choice, input, correction и controlled transform/translation; ошибки ведут к разбору и новому transfer item, а не только к повтору того же вопроса.

## Границы

- Входят общий runner, четыре типа задания и минимум 120 заданий для пяти тем времён.
- Не входят банки глагольных конструкций, частей речи и служебных слов из тикетов 04–06.

## Файлы

- `public/grammar-catalog-content.js`, `public/grammar-catalog.js` — времена и контракты четырёх типов.
- `public/modules/grammar.js`, `public/screens/grammar.js` — runner и интерфейс.
- `test/`, `e2e/` — доменные и browser-проверки.

## Definition of Done

- [ ] Пять тем времён содержат минимум 120 уникальных автоматически проверенных заданий, по 6 каждого типа на тему.
- [ ] Runner одинаково проверяет четыре типа, нормализует допустимые ответы и сохраняет точный error code/confusion pair.
- [ ] Открытие правила помечает evidence assisted; assisted session не продвигает stage.
- [ ] Ошибка выдаёт объяснение и отдельное неповторяющееся transfer-задание той же слабости.
- [ ] Mobile/desktop browser flow доказывает четыре типа, reload, stage и доступность.
- [ ] `npm test`, `npm run lint` и `npm run check` проходят; один коммит на тикет.
