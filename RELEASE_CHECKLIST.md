# Easy Boost — release checklist

## Автоматически проверено

- [x] Production-конфигурация требует PostgreSQL и JWT secret от 32 символов.
- [x] Docker image собирается и запускается от непривилегированного пользователя `node`.
- [x] Frontend собирается стадией образа: `dist/` исключён из контекста сборки, и в контейнер уезжает
      сборка из репозитория, а не из рабочего каталога релизящего.
- [x] PostgreSQL 17 проходит healthcheck; все SQL-миграции применяются автоматически.
- [x] Repository integration flow проверен на реальной PostgreSQL 17.
- [x] Chrome E2E проверяет demo, клавиатурную навигацию, слова, offline/recovery, сохранение прогресса, logout и PWA.
- [x] `/health/live` и `/health/ready` отвечают из production Compose.
- [x] Backup создаётся атомарно; restore проверяет архив и требует подтверждения.
- [x] Автоматизированный fixture-контракт backup/restore возвращает marker-запись и healthy-state; это не является current production-like evidence.
- [x] Проверка backup выполняет full restore только в disposable exact-image PostgreSQL container/volume
      без network/published ports и публикует success лишь после доказанного cleanup.
- [x] Cookie-session, CSRF, CSP и отсутствие frontend-секретов покрыты regression-тестами.
- [x] Telegram updates проходят строгую серверную валидацию, а HTML в сгенерированных ИИ строках отклоняется.
- [x] Текущие файлы и полная Git-история автоматически проверяются на секреты без вывода найденных значений.
- [x] `npm audit --omit=dev` сообщает 0 известных уязвимостей.
- [x] CI запускает миграции и integration-тест с PostgreSQL 17.
- [x] `npm run test:e2e:performance` держит пять бюджетов раздела 19 ТЗ. Финальный `npm run test:release:aisy` прошёл: artifact `d518f4a54e7b03beb357a69f7dc6380cd31befc5a11634c1ddd0df216021e290`, 26 уникальных Chromium-сценариев, first-load JS 90.0 KB / 150 KB, LCP 108 ms, CLS 0.000, INP 64 ms. Измерения 30 июля 2026 года остаются только [historical/superseded baseline](docs/PERFORMANCE_BASELINE.md).

## Перед первым production-запуском

- [ ] Отозвать ранее опубликованный frontend AI key и выпустить новый server-only key.
- [ ] Задать уникальные `JWT_SECRET` и `POSTGRES_PASSWORD` через secret storage платформы.
- [ ] Проверить точное совпадение `APP_URL` с публичным HTTPS origin.
- [ ] Настроить `TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_ID` и минимум один AI provider key.
- [ ] Настроить HTTPS reverse proxy и проверить forwarded protocol/IP headers.
- [ ] Настроить внешний backup storage, расписание и мониторинг неуспешных backup.
- [ ] Установить staging helper только из exact audited checkout через
      `sudo bash scripts/install-staging-release-helpers.sh`; подтвердить cross-process fd 7 flock на
      `/run/lock/easyboost-staging-helper/install.lock` и create-once canonical
      `/usr/local/lib/easyboost-staging-release/maintenance.lock` (`root:root 0600`, single-link,
      bytes содержат exact absolute install root и protocol). Hermetic non-root rehearsal должна
      использовать только private `/tmp/easyboost-staging-helper-installer.<uid>/install.lock`.
- [ ] Отрепетировать interrupted staging deploy/recovery только через установленный
      `/usr/local/sbin/easyboost-staging-recover`: launcher обязан доказать fd 7→fd 8 identity/digest и взять
      `/usr/bin/flock -n 8`, consumer — увидеть exclusive FLOCK в `/proc/self/fdinfo/8`, удалить
      maintenance metadata перед target и выдать отдельные root-bound deadline/session authorities.
      Для request и ACK отдельно проверить paired publication: exclusive-create private `0600`
      single-link record → write → `fsync(record)` → `fsync(control dir)` → exclusive-create zero-byte
      private `0600` single-link `<record>.ready` → `fsync(marker)` → `fsync(control dir)`; live reader
      обязан проверять marker первым. Orphan/unsafe/nonzero marker и malformed sealed record должны
      fail closed; unsealed record, включая zero-byte, допускается к cleanup только после proof
      owning-session settlement через retirement всего exact namespace. Individual unlink/repair
      record или marker запрещён.
      Проверить bounded 1024-slot terminal evidence, 32-link baton epoch и restart-resume exact
      `.maintenance-deletion.<64hex>` journal на границах claim→payload→zero-byte moved→delete; raw
      `rm`, ручной rename и prefix/glob cleanup control roots запрещены.
- [ ] Provision `/var/lib/easyboost/locks` как `root:root` `0750`, не создавать
      `host-operation.lock`, и зафиксировать единый
      `EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock` для staging,
      import, destructive restore и production app lifecycle.
- [ ] Проверить, что host-mutating restore/import/lifecycle entrypoints запускаются через `sudo/root`,
      raw `docker compose ... app` не используется, а database-only stop оставляет пустой app allocation.
- [ ] Выполнить restore rehearsal на отдельной production-like среде и приложить exact release commit, app/PostgreSQL image ID, backup SHA-256/age, migration count, marker round-trip, readiness и measured RPO/RTO.
- [ ] Во время rehearsal подтвердить pre-mutation capacity reservation на host/container, typed
      database-operation marker v3 (обычный retained) / v4 (local-child bridge) с UUID,
      exact `PGAPPNAME`, PostgreSQL container ID и последним settlement probe, а также typed
      host-operation recovery evidence.
- [ ] Отрепетировать три fail-closed recovery entrypoint без ручного удаления guards:
      `npm run production:app:recover`, `npm run production:import:recover` и
      `npm run production:restore:recover`; после незавершённого restore повторить полный
      database-only restore из проверенного архива до запуска приложения.
- [ ] Отдельно отрепетировать `PRODUCTION_IMPORT_LOCAL_CHILD_RECOVERY_REQUIRED`: app/start
      остаётся заблокирован, exact supervisor proof предшествует DB v4→retained transition,
      а повтор после обрыва завершается без ручного удаления guard/sidecar.
- [ ] Настроить алерты на `/health/ready`, HTTP 5xx и рост AI ошибок/таймаутов.

## Команды release gate

На production host заранее создайте только root-owned родительский каталог
`/var/lib/easyboost/locks` (`root:root 0750`). Exact guard
`/var/lib/easyboost/locks/host-operation.lock` создаёт и удаляет lifecycle wrapper; не создавайте его
вручную.

```bash
set -euo pipefail
npm ci
npm run test:postgres
npm run test:release:aisy
npm run quality:check
npm audit --omit=dev
: "${EASYBOOST_RELEASE_COMMIT:?set the owner-approved full lowercase commit SHA}"
[[ "$EASYBOOST_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || exit 1
if git symbolic-ref -q HEAD >/dev/null; then
  echo 'Release checkout must use detached HEAD' >&2
  exit 1
else
  symbolic_ref_status="$?"
  [ "$symbolic_ref_status" -eq 1 ] || exit 1
fi
[ "$(git rev-parse --verify HEAD)" = "$EASYBOOST_RELEASE_COMMIT" ] || exit 1
[ -z "$(git status --porcelain=v1 --untracked-files=all)" ] || exit 1
export EASYBOOST_POSTGRES_IMAGE='postgres:17-alpine'
: "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved sha256 image ID}"
[[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'PostgreSQL image ID must be a full canonical sha256 identity' >&2
  exit 1
}
export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
docker pull "$EASYBOOST_POSTGRES_IMAGE"
postgres_seed_image_id="$(docker image inspect --format '{{.Id}}' "$EASYBOOST_POSTGRES_IMAGE")"
[ "$postgres_seed_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ] || {
  echo 'Pulled PostgreSQL image does not match the owner-approved identity' >&2
  exit 1
}
: "${EASYBOOST_NODE_BASE_IMAGE:?set the owner-reviewed Node base image digest}"
[[ "$EASYBOOST_NODE_BASE_IMAGE" =~ ^node:22-bookworm-slim@sha256:[0-9a-f]{64}$ ]] || {
  echo 'Node base image authority must be an exact owner-reviewed digest' >&2
  exit 1
}
export EASYBOOST_NODE_BASE_IMAGE
npm run production:image:build -- --expected-commit "$EASYBOOST_RELEASE_COMMIT"
production_app_image_id="$(docker image inspect --format '{{.Id}}' easyboost-production-app:local)"
[[ "$production_app_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo 'Built application image has no canonical immutable identity' >&2
  exit 1
}
app_preflight_image_id="$(docker image inspect --format '{{.Id}}' easyboost-production-app:local)"
[ "$app_preflight_image_id" = "$production_app_image_id" ] || {
  echo 'Application image identity changed before immutable Compose binding' >&2
  exit 1
}
export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$production_app_image_id"
docker compose --project-name easyboost-production -f compose.production.yml config --quiet
postgres_preflight_image_id="$(docker image inspect --format '{{.Id}}' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID")"
[ "$postgres_preflight_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ] || {
  echo 'PostgreSQL image identity changed before Compose start' >&2
  exit 1
}
docker compose --project-name easyboost-production -f compose.production.yml up --pull never --no-build -d postgres
postgres_container_id="$(docker compose --project-name easyboost-production -f compose.production.yml ps -q postgres)"
[ -n "$postgres_container_id" ] || { echo 'PostgreSQL container is missing' >&2; exit 1; }
postgres_running_image_id="$(docker inspect --format '{{.Image}}' "$postgres_container_id")"
[ "$postgres_running_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ] || {
  docker compose --project-name easyboost-production -f compose.production.yml stop postgres
  echo 'Running PostgreSQL container does not use the owner-approved image' >&2
  exit 1
}
postgres_ready=0
for ((postgres_attempt=1; postgres_attempt<=30; postgres_attempt++)); do
  if docker compose --project-name easyboost-production -f compose.production.yml exec -T postgres pg_isready -t 2 -U easyboost -d easyboost \
    >/dev/null 2>&1; then
    postgres_ready=1
    break
  fi
  [ "$postgres_attempt" -eq 30 ] || sleep 1
done
[ "$postgres_ready" -eq 1 ] || {
  echo 'PostgreSQL did not become ready within 30 attempts' >&2
  exit 1
}
sudo install -d -o root -g root -m 0750 /var/lib/easyboost/locks
sudo --preserve-env=EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/production-app-lifecycle.js start
```

`npm run test:release:aisy` — единый канонический release-wrapper. Внутри него source/unit проверки
и clean-checkout secret/context guard выполняются до единственной сборки; digest-complete artifact
verification и browser E2E затем используют тот же собранный `dist/public` через явный no-build
runner `npm run test:e2e:aisy:built`. CI вызывает wrapper один раз и не воспроизводит его шаги вручную.
Production-образ собирается только через
`npm run production:image:build -- --expected-commit "$EASYBOOST_RELEASE_COMMIT"`: wrapper сначала
требует exact detached clean checkout на полном owner-approved commit, затем проверяет audited inventory,
делает два no-follow descriptor-pass по каждому input, сканирует все
bytes и передаёт deterministic USTAR только в stdin `docker build`. Docker не читает writable
temporary context; локальный `dist/` в stream не входит, frontend собирает стадия Dockerfile из
проверенных исходников.

Перед публичным заявлением о методической точности дополнительно выполнить `npm run quality:release -- quality/release.json` на наборе, независимо размеченном квалифицированным преподавателем.

Релиз разрешён только после заполнения внешних production-пунктов и успешного CI на конкретном release commit.
