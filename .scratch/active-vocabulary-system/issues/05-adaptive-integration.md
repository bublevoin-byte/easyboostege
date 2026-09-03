# 05 — Результаты слов в индивидуальном плане

Status: done
Blocked by: 03 — Умная тренировка активного вспоминания; 04 — Личные слова из чтения без противоречий
Spec: `.scratch/active-vocabulary-system/spec.md#implementation-decisions`

## Что сделать

Обычная завершённая тренировка слов записывает ограниченный результат по режимам, а персональный план может назначать доступные тематические и продуктивные занятия без притворства, что self-rating или Voice Tutor доказывают mastery.

## Границы

- Входит: module-attempt summary, расширенный vocabulary activity registry, безопасная связь с adaptive execution claim, Base/Premium границы и объяснимые evidence labels.
- Не входит: изменение общей формулы прогноза ЕГЭ или новые Writing/Speaking возможности.

## Definition of Done

- [x] Обычная сессия создаёт не более одной идемпотентной попытки с bounded metadata.
- [x] Objective и self-reported режимы не смешиваются в одну сильную оценку.
- [x] План может запускать несколько тематик и productive/context/listening practice, если контент доступен.
- [x] Base получает весь тренажёр; Premium остаётся границей Voice Tutor и deep reports.
- [x] Повреждённый или повторный клиентский результат не повышает доверенное mastery.
- [x] `npm run lint`, `npm run check` и целевые тесты проходят.
- [x] Один коммит на тикет.
