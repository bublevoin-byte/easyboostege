# 07 — Связать разбор со словами и личным планом

Status: ready-for-agent
Blocked by: 06
Spec: `.scratch/reading-2-pilot/spec.md#персональный-план`

## Что сделать

Подключить Reading 2.0 к существующему learning evidence/adaptive runtime, сохранению слов из текста и разбора, а также к Voice Tutor context без дублирования доменной логики. Правильно различать самостоятельные, assisted, незавершённые и восстановленные попытки.

## Границы

- Входит gist/detail evidence с фактическими maxScore/duration/id/revision.
- Входит запуск из индивидуальной сессии и завершение соответствующего шага плана.
- Входит сохранение слова с контекстом через существующий словарный контракт.
- Входит подготовка контекста ошибки для Voice Tutor, но не Premium-отчёт.

## Файлы

- Reading screen/domain integration
- `public/adaptive-activity-contract.js` и runtime/launch только при необходимости
- vocabulary/voice integration seams
- unit/integration/E2E tests

## Definition of Done

- [ ] Результаты корректно меняют профили `ege.reading.gist` и `ege.reading.detail`.
- [ ] Полный раздел создаёт две согласованные evidence slices без двойного учёта.
- [ ] Слово сохраняется один раз с исходным предложением/фрагментом.
- [ ] Voice context содержит вопрос, ответ ученика, ключ и доказательство без раскрытия до сдачи.
- [ ] Целевые тесты, `npm run lint`, `npm run check`, `npm test` проходят.
- [ ] Один коммит на тикет.

