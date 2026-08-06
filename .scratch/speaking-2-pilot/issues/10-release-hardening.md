# 10 — Провести выпускной аудит Speaking 2.0

Status: ready-for-agent
Blocked by: 09
Spec: `.scratch/speaking-2-pilot/spec.md#проверки`

## Что сделать

Собрать все вертикали в надёжный релиз-кандидат: закрыть расхождения со спецификацией, проверить безопасность, доступность, производительность, OpenAPI, миграции, тарифные границы и честные пользовательские формулировки. Финальный результат остаётся локальным до отдельного разрешения на push/deploy.

## Границы

- Входит полный regression, mobile/desktop E2E, performance, secret/history scan и независимый spec/standards review.
- Входит исправление обнаруженных P0–P3 в границах Speaking 2.0 и финальная документация эксплуатации.
- Входит список ручных шагов владельца: установка Azure SDK, env names, тестовый ресурс и отдельный paid smoke.
- Не входят npm install, реальные ключи, paid calls, push и deploy.

## Файлы

- все затронутые Speaking/API/storage/UI/test/docs files по результатам аудита
- `.scratch/speaking-2-pilot/` и `PROGRESS.md`

## Definition of Done

- [ ] Все критерии спецификации имеют тест, доказательство или честно отмеченный owner-action.
- [ ] `npm run lint`, `npm run check`, `npm test`, Speaking E2E и performance проходят.
- [ ] Security, privacy, repository parity, OpenAPI и migration checks проходят.
- [ ] Нет ложных заявлений «точный/экспертный/методически валидированный».
- [ ] Secret scan и `git diff --check` чисты; ключей и сырого обычного аудио нет.
- [ ] Независимые Standards и Spec reviews не содержат нерешённых P0–P3.
- [ ] Один финальный коммит; push/deploy не выполнялись.
