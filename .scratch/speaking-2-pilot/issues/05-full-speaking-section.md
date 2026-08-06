# 05 — Собрать полный устный раздел из 20 баллов

Status: done
Blocked by: 04
Spec: `.scratch/speaking-2-pilot/spec.md#полный-устный-раздел`

## Что сделать

Ученик запускает полный устный вариант, получает совместимый серверный набор всех четырёх заданий, проходит их в официальном порядке и видит разбор только после окончательной сдачи. Незавершённая попытка безопасно восстанавливается, а повторная сдача идемпотентна.

## Границы

- Входит owner-bound session/response model с каталогом, ревизиями, этапами, временем и состояниями ответа.
- Входит выбор полного варианта, официальный порядок, отсутствие раннего раскрытия и итоговая шкала 0–20.
- Входит одинаковое поведение файлового и PostgreSQL-хранилищ, экспорт и удаление.
- Не входят Azure, окончательная автоматическая оценка и экспертная калибровка.

## Файлы

- Speaking routes and service/domain modules
- `storage/file-repository.js`, `storage/postgres-repository.js`, migration and database schema docs
- Speaking module and screen
- route, repository parity, frontend and E2E tests

## Definition of Done

- [x] Полная сессия закрепляет четыре серверных задания и максимум 1+4+5+10=20.
- [x] До финальной сдачи нет ответа, балла или разбора ни в API, ни в UI.
- [x] Восстановление требует совпадения каталога/revision, а submit идемпотентен.
- [x] Owner isolation, экспорт и удаление одинаково работают в двух хранилищах.
- [x] Полный desktop/mobile сценарий проходит с fake MediaRecorder.
- [x] Целевые тесты, `npm run lint`, `npm run check`, `npm test` проходят.
- [x] Один коммит на тикет.

## Результат

Полный устный раздел теперь создаёт owner-bound серверную сессию с одним совместимым вариантом
заданий 1–4, закреплёнными ревизиями, официальным порядком 1+4+5+1 ответов и максимумом 20 баллов.
Этапы подготовки и ответа восстанавливаются по серверным deadline; одиннадцать записей остаются
локальными, а хранилища получают только ограниченные metadata. До тикетов 06–07 результат честно
возвращает `earnedScore: null` и недоступную оценку без готовых ответов, рубрик, transcript или audio.
Файловый и PostgreSQL-контракты покрывают owner isolation, fail-closed revision restore, канонический
идемпотентный submit, export и cascade deletion. Прошли 1030 unit/integration tests, disposable
PostgreSQL 20/20, полный Chromium E2E и отдельный fake MediaRecorder сценарий на 375/1440 px, а также
lint, check, frontend build и оба secret scan. По первому независимому Standards/Spec review исправлены
server deadline, Task 3 TTS-before-recording, LRU-ротация, HTTP 400, safe restart, четыре опоры Task 2,
явный skip и итоговые duration/deferred-plan. По повторному review добавлены интеграционные гарантии
`TTS → /stage`, отсутствие подготовки/replay в Task 3, recovery через 404 для `abandoned`, строгий SQL
status/phase, точный OpenAPI и реальное локальное воспроизведение; платных вызовов, сети провайдеров,
push и deploy не было.
