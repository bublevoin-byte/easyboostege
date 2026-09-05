# 08 — Восстановить достоверность Linux CI fixtures

Status: in-progress
Blocked by: —
Spec: .scratch/staging-v4-cutover/spec.md#ci-repair-после-run-33870937009

## Что сделать

Исправить шесть подтверждённых дефектов тестов, чтобы CI проверял реальные условия Node,
host-lock, installer maintenance и PostgreSQL runtime authority.

## Границы и файлы

- test/frontend-aisy-release.test.js: pin Node 22.23.2.
- test/production-image-build.test.js: актуальный текст timeout 60 минут.
- test/staging-cutover-host-lock.test.js: displaced claim source и эквивалентные безопасные отказы ancestry.
- test/staging-helper-install-maintenance.test.js: приватный chmod-safe Node fixture без изменения guard.
- test/staging-release-lock.integration.test.js: labelled docker ps и JSON PostgreSQL/volume inspect.
- Только перечисленные тесты и этот тикет; production scripts, общие docs и issue 05 не входят.

## Definition of Done

- [x] Все шесть причин устранены без удаления тестов и ослабления проверяемой защиты.
- [ ] Focused tests/review пройдены; Linux-only доказательства явно отмечены.
- [x] Общие lint/check/npm test пройдены; отдельный коммит делает координатор.

## Реализация

Реализовано; статус остаётся `in-progress` до общих проверок, независимого review и коммита
координатора.

- Assertion Node закреплён на `22.23.2`, timeout assertion использует действующий текст runbook.
- Replaced-inode fixture копирует claim из displaced directory. Проверка чужого PID сохраняет
  обязательный status 70 и принимает оба безопасных отказа ancestry.
- Installer fixture копирует Node в приватный каталог, выставляет 0755 каталогу и executable и
  устанавливает первый bundle через этот Node. Только тестовая копия shell installer выбирает
  тот же Node через свой фиксированный PATH. Production owner/mode guard не менялся.
- Fake Docker возвращает PostgreSQL ID, labels, image, health, mount и named-volume inspection
  с совпадающей authority. Дополнительно исправлены связанные данные той же фикстуры: build
  различает release SHA текущего и candidate archive, а readiness отказывает по точному candidate
  image ID. Существующий сценарий проверяет image после deploy, rollback и recovery.

Проверено локально на Windows:

- Focused name-filter: 9 тестов, 5 passed, 4 Linux-only skipped, 0 failed.
- ESLint всех пяти изменённых тестовых файлов прошёл; повторный ESLint и `node --check`
  release-lock fixture после последней правки прошли.
- `git diff --check` прошёл.

Настоящие Linux inode/flock, private Node installation и PostgreSQL authority в полном lock
integration проверяет координатор в изолированном Linux runtime. Windows skips не считаются
доказательством прохождения этих сценариев. Общие gates и независимый review пока не заявлены.

2026-09-05 — Финальный Linux rerun координатора: host-lock + installer maintenance —
17 tests, 17 passed, 0 failed/skipped (4.7 s). Независимые Standards/Spec review: 0/0 findings.
Real-flock integration остаётся за настоящим GitHub Linux CI: Docker Desktop выдаёт PID `0` в
`/proc/self/fdinfo`, который production guard обоснованно не принимает. Изолированный минимальный
probe воспроизвёл это ограничение среды; guard не менялся. Общие Windows gates ещё выполняются.

Итог общего Windows gate: 3218 tests, 3119 passed, 99 штатных skips, 0 failed/cancelled
(2999.1 s). Полные lint/check, secret/history scans и diff check прошли. Anonymous-memory flock
probe на самом staging показал positive PID, не Docker Desktop PID 0; сервер не менялся.
Единственное незакрытое доказательство этого тикета — полный real-flock сценарий в GitHub Linux CI.
