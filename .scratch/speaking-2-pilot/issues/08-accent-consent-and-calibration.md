# 08 — Добавить профиль акцента и приватную калибровку

Status: ready-for-agent
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

- [ ] «Не знаю» выполняется один раз и сохраняет предложенный профиль без выбора лучшего балла на каждой попытке.
- [ ] Смена en-GB/en-US явна, аудируема и влияет только на будущие оценки.
- [ ] Учебная и калибровочная обработки имеют разные согласия; отказ не ограничивает обучение.
- [ ] Экспертная карточка не содержит имени/VK ID и требует две независимые оценки.
- [ ] Сырой calibration audio удаляется после двух оценок, отзыва или 180 дней.
- [ ] Guardian gate закрывает калибровку несовершеннолетнего без подтверждения.
- [ ] Целевые тесты, `npm run lint`, `npm run check`, `npm test` проходят.
- [ ] Один коммит на тикет.
