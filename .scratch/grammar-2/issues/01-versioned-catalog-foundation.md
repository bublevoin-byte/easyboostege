# 01 — Версионированный каталог без потери текущей грамматики

Status: done
Blocked by: —
Spec: `.scratch/grammar-2/spec.md#implementation-decisions`

## Что сделать

Перенести все существующие 20 тем, 200 упражнений (100 `c` + 25 `c2` + 75 `f`) и три комплекта 19–24 с 18 пропусками из экранного кода в автоматически проверяемый immutable catalog registry со стабильными ID и версиями. Прежняя оценка 175 не учитывала отдельные `c2`; ни одно из них не должно потеряться. Текущий экран продолжает работать на новом каталоге, а старые ссылки Voice Tutor и adaptive activity не меняют смысл.

## Границы

- Входят каталог текущей версии, строгая схема, полный coverage report, подключение экрана, offline shell, generated supplement и Voice Tutor.
- Не входят новые задания, четыре активных уровня, новая mastery-модель, серверная история и изменения индивидуального плана из тикетов 02–08.

## Файлы

- `public/grammar-catalog-content.js`, `public/grammar-catalog.js` — единый контент и проверяемый реестр.
- `public/screens/grammar.js`, `public/service-worker.js` — потребитель каталога и offline shell.
- `voice-tutor/core-catalog.js`, `voice-tutor/generated-core-catalog.js`, `scripts/build-core-voice-catalog.js` — единый источник Voice Tutor без скрытой грамматической копии.
- `test/grammar-catalog.test.js`, `test/voice-tutor-core-catalog.test.js`, `test/learning-activity-recorder.test.js` — catalog/backcompat/screen contracts.

## Definition of Done

- [x] Registry содержит все 20 тем, четыре группы, 200 существующих упражнений и три комплекта 19–24 без потери ответов/объяснений.
- [x] Schema отклоняет неизвестные типы, пустые ответы, неверные индексы, дубликаты и несовпадающие ID, неверные revision и неподдерживаемую разметку.
- [x] Экран, offline fallback, generated supplement и Voice Tutor используют catalog API, а не скрытые копии банка.
- [x] Stable IDs/version/revision и полный автоматический coverage report проверяют все 200 упражнений и 18 exam gaps.
- [x] Старые grammar tests, `npm test`, `npm run lint`, `npm run check`, frontend build и browser smoke проходят.
- [x] Один коммит на тикет.
