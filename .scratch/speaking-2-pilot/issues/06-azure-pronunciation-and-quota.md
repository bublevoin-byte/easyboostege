# 06 — Подключить Azure-контур произношения и квоты

Status: done
Blocked by: 05
Spec: `.scratch/speaking-2-pilot/spec.md#провайдер-акустической-оценки`

## Что сделать

Оценка записи проходит через серверный Azure Pronunciation adapter: ученик получает доверенную расшифровку, слова, фонемы, беглость и техническое качество, а расход оплачиваемых секунд надёжно ограничен тарифом 60/240 минут. Без установленной SDK или конфигурации система закрывается честным управляемым состоянием.

## Границы

- Входит provider interface, fake adapter и production adapter для официальной непрерывной SDK.
- Входят env names, timeouts, bounded payload, нормализация en-GB/en-US, технические ошибки и redacted logging.
- Входит monthly quota ledger с reservation/finalize/release и идемпотентностью.
- Не входят установка SDK, создание Azure-ресурса, секреты и реальные платные вызовы.

## Файлы

- новые Speaking provider, quota and orchestration modules
- Speaking routes, storage adapters, migrations and OpenAPI
- env/example and operations documentation without values
- provider, quota, security and route tests

## Definition of Done

- [x] Fake Azure проходит сценарии success, low quality, timeout, partial result и unavailable.
- [x] en-GB не получает en-US-only показатели и не превращает unavailable в ноль.
- [x] Base получает 3600 секунд, Premium 14400; локальная запись расходует 0.
- [x] Один idempotency key не списывает секунды дважды, а неиспользованный резерв освобождается.
- [x] Секреты, бинарное аудио и полный provider payload отсутствуют в логах/ответах.
- [x] Без SDK/config UI показывает честное недоступное состояние.
- [x] Целевые тесты, `npm run lint`, `npm run check`, `npm test` проходят.
- [x] Один коммит на тикет.
