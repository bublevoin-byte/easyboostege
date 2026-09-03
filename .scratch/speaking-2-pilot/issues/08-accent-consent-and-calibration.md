# 08 — Добавить профиль акцента и приватную калибровку

Status: done
Blocked by: 07
Spec: `.scratch/speaking-2-pilot/spec.md#конфиденциальность-и-согласия`

## Что сделать

Ученик осознанно выбирает британскую или американскую норму либо проходит один короткий dual-accent setup; отдельно и добровольно может разрешить анонимную экспертную калибровку. Обычные записи остаются ephemeral, а калибровочные удаляются после двух оценок или 180 дней.

## Границы

- Входит owner-bound accent profile, one-time «не знаю», ручная смена и audit metadata.
- Входят отдельные consent records, guardian gate, blinded expert queue, две независимые оценки и adjudication-state.
- Входят retention, revoke, export/delete и parity двух хранилищ.
- Не входят юридическая сертификация, найм экспертов и реальные персональные данные эксперта.

## Файлы

- Speaking accent/calibration domain and routes
- storage adapters, migrations, privacy/OpenAPI docs
- Speaking first-run and consent UI
- privacy, retention, repository and frontend tests

## Definition of Done

- [x] «Не знаю» выполняется один раз и сохраняет предложенный профиль без выбора лучшего балла на каждой попытке.
- [x] Смена en-GB/en-US явна, аудируема и влияет только на будущие оценки.
- [x] Учебная и калибровочная обработки имеют разные согласия; отказ не ограничивает обучение.
- [x] Экспертная карточка не содержит имени/VK ID и требует две независимые оценки.
- [x] Сырой calibration audio удаляется после двух согласованных оценок, третьей adjudication-оценки при существенном расхождении, отзыва или 180 дней.
- [x] Guardian gate закрывает калибровку несовершеннолетнего без подтверждения.
- [x] Целевые тесты, `npm run lint`, `npm run check`, `npm test` проходят.
- [x] Один коммит на тикет.

## Historical safe-pause checkpoint — 2026-08-06

Реализация, миграция 049, file/PostgreSQL parity, production wiring, first-run/consent UI,
OpenAPI и privacy/retention docs готовы. Целевой accent-контур проходит 16/16, полный unit suite —
1126 total (1104 pass, 22 штатных skip, 0 fail), полный Chromium E2E, `npm run lint`,
`npm run check`, frontend build, secret/history scans и `git diff --check` проходят. Одноразовый
живой PostgreSQL-контур применил миграции 001–049 и прошёл 22/22, затем container/network/volume
удалены. Платных/provider-вызовов, установки SDK, push и deploy не было.

Осталось после паузы: два независимых Standards/Spec review, исправление всех P0–P3 до двух
нулевых re-review, финальный повтор пропорциональных gates, перевод статуса в `done` и единственный
локальный commit тикета 08. Сейчас коммита нет.

## Final checkpoint — 2026-08-07

Тикет завершён. Помимо основного акцентного профиля и добровольной слепой калибровки, финальное
укрепление закрыло устаревшие снимки профиля при конкурентном назначении, взаимоисключение ручного
выбора и setup, allowlisted export без evidence keys, полное обезличивание reviewer identities,
неизменяемые server-owned task/rubric snapshots для архивных каталогов, точную 180-дневную границу
даже при активной review-аренде и отсутствие starvation после 25 занятых строк PostgreSQL.

Финальные проверки: целевой accent/API/file контур 18/18, operations/docs 3/3, полный `npm test` —
1134 total (1111 pass, 23 штатных PostgreSQL skip, 0 fail), полный Chromium E2E, lint/check, frontend
build, secret/history scans и `git diff --check` прошли. Чистая disposable PostgreSQL применила миграции
001–049 и прошла 23/23; container/network/volume удалены. Два независимых финальных re-review:
Standards — `ZERO_FINDINGS`, Spec — `ZERO_FINDINGS`. Платных/provider-вызовов, установки SDK, push и
deploy не было. Тикет оформлен одним локальным commit.
