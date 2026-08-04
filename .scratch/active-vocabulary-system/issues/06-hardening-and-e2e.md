# 06 — Мобильная проверка и выпускной контур

Status: ready-for-agent
Blocked by: 05 — Результаты слов в индивидуальном плане
Spec: `.scratch/active-vocabulary-system/spec.md#testing-decisions`

## Что сделать

Цельный Words 2.0 проходит пользовательский E2E от главной до библиотеки, карточки, смешанной сессии, ошибки и итогов; миграция, офлайн, адаптивная передача, доступность и операционные ограничения закреплены документацией и проверками.

## Границы

- Входит: браузерные сценарии, file/PostgreSQL parity, build/performance regression, API/docs/schema, accessibility и release evidence.
- Не входит: push, deploy, включение feature flag и платный провайдерный прогон.

## Definition of Done

- [ ] Chromium проверяет keyboard flow и 375px mobile flow без внешних AI/TTS вызовов.
- [ ] Offline-сессия сохраняется и после восстановления сети синхронизирует результат без дубля.
- [ ] Миграции и оба repository backend проходят parity/export/delete проверки.
- [ ] Полный `npm run lint`, `npm run check`, `npm test`, frontend build и релевантные E2E проходят.
- [ ] Независимые Standards и Spec review не имеют незакрытых P0–P2.
- [ ] Evidence фиксирует, что push/deploy/paid calls не выполнялись.
- [ ] Один коммит на тикет.
