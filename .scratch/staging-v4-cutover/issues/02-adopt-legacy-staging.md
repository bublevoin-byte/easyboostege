# 02 — Принять legacy staging в immutable-archive-v4

Status: implemented; Linux/live verification pending
Blocked by: 01 — завершить recovery зависшей staging-транзакции
Spec: .scratch/staging-v4-cutover/spec.md#adopt-legacy-staging

## Что сделать

Добавить отдельную явную operator-команду первого перехода, которая под общими staging locks
доказывает происхождение и неизменность работающего pre-v4 staging, переводит только его code/image
metadata в проверяемый bridge-релиз `immutable-archive-v4` и после этого делает обычные deploy/rollback
доступными без удаления PostgreSQL volume или остановки текущего приложения.

## Границы

- Входит отдельный `cutover/adopt` entrypoint; обычный deploy продолжает отвергать legacy state.
- Входит canonical bridge archive, совпадающий с live tree во всех файлах кроме явно заменяемого
  `compose.staging.yml`, и проверка exact legacy marker/Compose SHA.
- Входит атомарная публикация archive+sidecar+marker, привязка stable tag к уже работающему app image,
  точная проверка running app/PostgreSQL identities, readiness, идемпотентный повтор и checked recovery.
- Не входят изменения transaction/deadline/session supervisor, удаление контейнеров/volume, миграция или
  откат PostgreSQL, перенос секретов, production deploy и неявное угадывание legacy release.

## Публичные seams

- `staging-release-archive.js verify-tree-transition ARCHIVE DIRECTORY compose.staging.yml` — доказывает
  exact tree equality, разрешая отличаться только одному заранее названному regular file.
- `/usr/local/sbin/easyboost-staging-cutover BRIDGE_ARCHIVE BRIDGE_SHA LEGACY_MARKER_SHA
  LEGACY_COMPOSE_SHA LEGACY_APP_MODE LEGACY_MARKER_MODE LEGACY_COMPOSE_MODE
  immutable-archive-v4 BUNDLE_SHA` — единственная команда мутации cutover; mode tuple входит в
  durable journal и не выводится из изменяемого pathname во время операции.

## Файлы

- `scripts/staging-release-archive.js` — проверка bridge/live transition.
- `scripts/staging-cutover.sh` — bounded transactional cutover.
- `scripts/staging-helper-bundle.js` — digest/install/dispatcher нового entrypoint.
- `scripts/staging-release-common.sh` — только переиспользуемые точные проверки/cleanup при необходимости.
- `test/staging-release-archive.test.js` — contract archive transition.
- `test/staging-deploy.test.js` — operator-level cutover success/refusal/recovery.
- `README_DEPLOY.md`, `docs/KNOWN_LIMITATIONS.md` — точный one-time runbook и ограничения.

## Definition of Done

- [x] RED→GREEN: bridge archive может отличаться от live tree только exact `compose.staging.yml`.
- [x] Legacy marker/tree/Compose/running image/PostgreSQL/readiness проверены до первой мутации.
- [x] Успех публикует exact private archive+sidecar+marker и stable image, не меняя DB/env/backups.
- [x] Повтор идемпотентен; mismatch, unsafe path/mode, partial state и failure injection fail-closed.
- [x] После cutover обычный deploy и rollback принимают сохранённого predecessor.
- [x] Existing legacy-without-explicit-cutover deploy rejection остаётся зелёным.
- [x] Focused tests, `npm run lint`, `npm run check` и `git diff --check` проходят.
- [ ] Коммит выполняет координатор после проверки общего diff.

## Verification checkpoint

- Windows: targeted runtime-authority, helper-bundle, portable host-lock, normal-deploy happy-path
  and release-lock concurrency tests are green; POSIX-only cases remain deferred to Linux CI.
- Production cutover tests are explicitly Linux-only because the typed owner proof binds `/proc`,
  boot id and POSIX inode semantics; Linux CI/live dry-run remains required before operator use.
