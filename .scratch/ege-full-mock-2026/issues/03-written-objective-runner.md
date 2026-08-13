# 03 — Письменный runner заданий 1–36

Status: ready-for-agent
Blocked by: 01, 02
Spec: .scratch/ege-full-mock-2026/spec.md#пользовательский-сценарий

## Что сделать

Собрать единый written runner для аудирования 1–9, чтения 10–18 и грамматики/лексики 19–36 с общим строгим deadline 190 минут. До старта скачать и проверить exact assets; внутри попытки разрешить навигацию, autosave, reload/offline continuation и обзор пропусков, но запретить подсказки/баллы/ключи.

## Границы

- Входит browser state machine, asset preflight, strict timer/auto-submit, durable offline queue, exact server submit и objective result envelope.
- Переиспользуются deep section modules; копирование их UI-state машин не допускается.
- Не входит writing, speaking и финальный breakdown screen.

## Файлы

- `public/modules/`, `public/screens/`, `public/service-worker.js` — runner/PWA.
- `test/`, `e2e/` — browser/reload/offline/timer/property seams.

## Definition of Done

- [ ] RED доказывает отсутствие общего strict runner до реализации.
- [ ] Все 36 objective positions отвечаются и восстанавливаются exact.
- [ ] Таймер не ставится на паузу reload/offline и автосдаёт с blanks.
- [ ] Аудио полностью доступно после preflight; failed preflight не запускает timer.
- [ ] Offline completion replay-safe и не создаёт двойной submit/result.
- [ ] Mobile/desktop keyboard, 44 px, reduced motion и no-overflow seams зелёные.
- [ ] Full gates, fresh double ZERO review и один локальный commit.
