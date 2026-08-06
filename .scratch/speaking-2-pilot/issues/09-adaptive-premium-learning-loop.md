# 09 — Связать Speaking с планом, Premium и Voice Tutor

Status: ready-for-agent
Blocked by: 08
Spec: `.scratch/speaking-2-pilot/spec.md#индивидуальный-план-и-premium`

## Что сделать

Каждая надёжная попытка превращается в навыковые evidence и реально меняет индивидуальный план. Обычный подписчик получает полный текущий разбор, а Premium — продольный фонетический отчёт, целевые упражнения, сравнение попыток и Voice Tutor из конкретной ошибки.

## Границы

- Входит evidence по четырём заданиям, критериям, словам/фонемам и качеству сигнала.
- Входит adaptive selection, targeted re-check на новом материале и защита от assisted/low-confidence mastery.
- Входит base/Premium entitlement contract и расширенный отчёт без ухудшения base.
- Не входят VK/Robokassa и изменение общей коммерческой модели.

## Файлы

- adaptive learning routes/services and Speaking activity contract
- Voice Tutor recovery/capsule integration
- Speaking report UI
- adaptive, entitlement, Voice Tutor, retention and frontend tests

## Definition of Done

- [ ] Валидная попытка публикует отдельные speaking skills, а техническая/подсказанная не повышает mastery.
- [ ] План выбирает слабый критерий и проверяет его на новом материале.
- [ ] Base всегда видит полный разбор текущей попытки и 60 минут оценки.
- [ ] Premium получает 240 минут, динамику, сравнение, targeted practice и Voice Tutor.
- [ ] Voice Tutor использует bounded error context и не переписывает официальный результат.
- [ ] Целевые тесты, `npm run lint`, `npm run check`, `npm test` проходят.
- [ ] Один коммит на тикет.
