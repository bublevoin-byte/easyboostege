# 08 — Добавить Premium-отчёт и провести релизное укрепление

Status: done
Blocked by: 07
Spec: `.scratch/reading-2-pilot/spec.md#разбор-и-отчёты`

## Что сделать

Добавить честное разделение обычной подписки и Premium: базовый пользователь получает весь контент и доказательный разбор, Premium — голосовой разбор конкретной ошибки и расширенный персональный отчёт. Затем провести сквозной аудит каталога, доступа, offline/error states, документации и тестов Reading 2.0.

## Границы

- Входит расширенный отчёт по gist/detail, темам, уровням, времени и повторным ошибкам на основе существующих попыток.
- Входит entitlement gate только для Voice/expanded report, без ухудшения core Reading.
- Входит финальная сверка официальных формулировок, service worker/static assets и документации.
- Не входит платёжный провайдер, VK, push, deploy или production rollout.

## Файлы

- Reading report/voice UI and modules
- tests/E2E/offline/security contracts
- service worker/static manifest при необходимости
- product/readiness documentation and `PROGRESS.md`

## Definition of Done

- [x] Обычная активная подписка открывает все 60 комплектов, тренировки, полный раздел и базовый разбор.
- [x] Premium открывает Voice Tutor и расширенный отчёт; entitlement проверяется безопасно.
- [x] Метка автоматической проверки и юридически честные оговорки видны/доступны.
- [x] Полный `npm run lint`, `npm run check`, `npm test`, релевантный Chromium E2E и `git diff --check` проходят.
- [x] Документы/PROGRESS отражают фактический статус и сохраняют полный пробник как следующий этап.
- [x] Один коммит на тикет.
