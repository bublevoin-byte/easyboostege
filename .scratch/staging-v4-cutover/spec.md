# Staging v4 cutover

## Цель

Без потери работающего staging и PostgreSQL volume завершить первый переход с legacy release state
на проверяемый `immutable-archive-v4`, после чего штатные deploy/rollback снова должны работать.

## Наблюдаемое исходное состояние

- На staging работает pre-v4 code tree и контейнеры; readiness остаётся зелёным.
- `.release-sha256` относится к старому `git archive`, но `rollbacks/releases/` не был создан/заполнен.
- v4 helper установлен, а неуспешная попытка оставила authenticated deadline/session recovery residue.
- Старый archive не является canonical v4 archive, а старый `compose.staging.yml` не соответствует v4
  local-only image/guarded-context contract.

## Инварианты

- Ни recovery, ни cutover не удаляют staging PostgreSQL container, volume, network, данные или backup.
- Обычный deploy не угадывает legacy state и продолжает fail-closed без explicit cutover.
- Все mutable operator paths находятся под существующими release/host locks и bounded supervisor.
- Любая authority/identity/byte mismatch останавливает операцию до мутации либо оставляет точную
  recovery authority; broad/glob cleanup запрещён.
- Успех заявляется только после exact archive+sidecar+marker/store, stable/running image и readiness proof.

## Recovery collision

Issue 01 устраняет зацикливание authenticated deadline/session retirement, не ослабляя identity checks и
не превращая ручное удаление `/tmp` control namespaces в допустимый runbook.

## Adopt legacy staging

Issue 02 добавляет отдельный one-time cutover entrypoint. Operator передаёт canonical bridge archive,
его full SHA, наблюдаемый legacy marker SHA и SHA legacy Compose. Bridge обязан совпасть с live tree во
всех именах/байтах кроме exact `compose.staging.yml`; новый Compose проходит v4 validator. Команда
доказывает running app/PostgreSQL image identities, привязывает уже работающий app image к stable tag,
атомарно публикует bridge archive+sidecar+marker и не вызывает Compose `down`, `up` или DB migration.

## Не входит

- Production deploy, перенос или публикация секретов.
- Откат/down-migration PostgreSQL.
- Удаление старого staging ради clean first-deploy.
- Ослабление canonical archive, release-store, Compose, image или recovery проверок.

## CI repair после run 33870937009

Исходная точка: `944b9b8`; 11 падений Linux CI объединены в 9 причин. Цель — устранить
подтверждённые ошибки в существующих operator seams, сохранив контракты и работающий staging.

- Transaction supervisor сохраняет точную retirement authority, возвращённую POSIX `dispose()`,
  во всех трёх путях завершения. Неполное transaction recovery возвращает status 125 и authority.
- Standalone POSIX/deadline cleanup сохраняет прежний контракт логического завершения с retained
  evidence; transaction cleanup/completion использует явное строгое требование reclaim, в том числе
  при повторном retirement/publication recovery. Ранее подтверждённые отсутствующие стороны
  сохраняют `null`, а не получают новый путь. Глобальная замена standalone контракта или ослабление
  identity/ownership checks запрещены.
- Cutover вычисляет корректный 64-символьный hex nonce и проходит существующие Linux
  success/refusal/roll-forward сценарии.
- Тестовые assertions соответствуют закреплённому Node 22.23.2 и действующему runbook. Linux
  fixtures используют приватный безопасный Node, правильный displaced inode path и полную
  PostgreSQL container/volume authority. Проверки отказа и защиты остаются обязательными.
- Проверки: существующие CLI/operator и exported supervisor seams; новые регрессии только для
  подтверждённых ошибок. Focused checks, независимый Standards/Spec review, lint/check/npm test
  перед коммитами; Linux CI обязателен перед следующим deploy.

Вне объёма: issue 05, изменение UI/БД, ручное удаление recovery evidence и запуск живого deploy.
