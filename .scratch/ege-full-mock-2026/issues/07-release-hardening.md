# 07 — Выпуск полного пробника

Status: done
Blocked by: 01, 02, 03, 04, 05, 06
Spec: .scratch/ege-full-mock-2026/spec.md#acceptance-gates

## Что сделать

Заменить «в разработке» на настоящий вход в полный пробник и закрыть release contour: PWA asset/version behavior, mobile/desktop accessibility, offline queue/reconnect, strict timer expiry, cross-tab/owner switch, observability, privacy, OpenAPI/ops/retention docs и полный E2E от старта письменной до результата устной. Зафиксировать напоминание о Ticket 99.

## Границы

- Входит только интеграция и hardening уже реализованного варианта.
- Не входит второй вариант, provider quality run, push или deploy.
- Docker start/stop остаётся действием root/владельца по установленному протоколу.

## Файлы

- `public/`, `e2e/`, `test/` — shell/release E2E.
- `docs/`, `PROGRESS.md`, `.scratch/ege-full-mock-2026/` — contracts/evidence/closeout.
- server/repository/OpenAPI — только найденные release parity gaps, с TDD.

## Definition of Done

- [x] Home card запускает full mock; старый placeholder отсутствует.
- [x] Full desktop/mobile E2E проходит 42 задания, reload/offline/reconnect и result without duplicates.
- [x] Keyboard, 44 px, screen reader, reduced motion и 320 px no-overflow зелёные.
- [x] Full unit/lint/check/build/OpenAPI/security/history/diff/audit зелёные.
- [x] Fresh disposable PostgreSQL применяет все миграции, shared contract green и полностью очищается.
- [x] Fresh Standards + Spec возвращают literal `ZERO_FINDINGS` на одной frozen identity.
- [x] Ticket/PROGRESS done; один локальный commit; push/deploy отсутствуют.
- [x] В финальном сообщении владельцу явно напомнить: банк нужно существенно расширить (Ticket 99).
