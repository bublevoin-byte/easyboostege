# Операционные ворота экспериментального релиза

Статус: **план для будущих owner-approved действий**. В ходе локального аудита ни один пункт этого файла не выполнялся.

Исходный application candidate аудита: `661a98974aac7bbc69dc321a876eacee65ec9819`.
Перед push владелец фиксирует **итоговый audit-record commit** из результата тикета 05; ниже он обозначен `<AUDIT_COMMIT_SHA>`.

## Общий порядок

1. Владелец подписывает решение по точному `<AUDIT_COMMIT_SHA>` и заводит защищённый каталог evidence вне Git.
2. Сначала ротируются ранее использовавшиеся секреты изолированного staging; production-ротация повторяется в отдельно разрешённое окно до production-запуска.
3. Одно owner-разрешение охватывает push и автоматически запускаемый им staging deploy; без такого разрешения push запрещён.
4. Сразу после успешного staging deploy начинается новый candidate-specific 7-day soak; старая история не засчитывается.
5. На том же неизменном staging-кандидате проходят физические браузеры, реальная PWA install/offline и внешняя alert-delivery.
6. Полная recovery-тренировка проходит на втором изолированном сервере и не меняет production/staging.
7. Только после `complete: true` у soak и подписанных evidence всех ворот владелец принимает отдельное решение о production.

Общие stop conditions: нет явного owner approval, SHA не совпал, тайна попала в output/evidence, неясен целевой host/environment, есть потеря данных или critical/high дефект. При любом из них дальнейший переход запрещён.

## 1. Ротация ранее использовавшихся секретов

**Owner:** владелец проекта; для PostgreSQL — администратор БД; для provider keys — владелец provider account.

**Prerequisites:** защищённое secret storage, доступ к provider audit log, резервная копия, согласованное maintenance window и понимание, что смена `JWT_SECRET` завершит все сессии. Staging и production имеют разные секреты и ротируются раздельно.

**Safe steps:**

1. Составить инвентарь только имён: `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`, `XAI_API_KEY`, `GROQ_API_KEY`, `POSTGRES_PASSWORD`, `MONITORING_TOKEN` и ранее опубликованный frontend AI key. Значения не копировать в issue, shell history, CI log и evidence.
2. Ротировать по одному. Создать новый provider key, не отключая старый; обновить только secret storage нужной среды; перезапустить только app.
3. Для PostgreSQL в одном окне обновить пароль роли и `DATABASE_URL`; до этого сделать backup. Ни одна команда не должна печатать connection string.
4. Взять exact application image ID из owner-approved release-записи и проверить среду без вывода env:

   ```bash
   set -euo pipefail
   : "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the owner-approved canonical app image ID}"
   [[ "$EASYBOOST_PRODUCTION_APP_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
     echo 'Approved application image ID is not canonical' >&2
     exit 1
   }
   export EASYBOOST_PRODUCTION_APP_IMAGE_ID
   : "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
   [[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
     echo 'PostgreSQL image ID must be a full canonical sha256 identity' >&2
     exit 1
   }
   export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
   sudo install -d -o root -g root -m 0750 /var/lib/easyboost/locks
   sudo --preserve-env=EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
     /usr/bin/node scripts/production-app-lifecycle.js restart
   docker compose --project-name easyboost-production -f compose.production.yml logs --tail=100 app
   npm run security:secrets
   npm run security:history
   ```

   Для staging использовать `compose.staging.yml`, `.env.staging` и loopback-порт staging; production-команды на staging не копировать.
5. После успешной health и одного безопасного запроса отозвать старый key/provider credential. Ранее опубликованный frontend key отозвать без отлагательства, как только server-only replacement проверен.

**Evidence artifact:** журнал с environment, именем secret, UTC-временем, provider audit-event ID, exit codes health/scans и именем owner. Никаких значений или фрагментов секрета.

**Success:** каждый старый credential отозван, новый работает только на сервере, health ready, БД доступна, ожидаемый logout после JWT-ротации зафиксирован.

**Stop/rollback:** не отзывать старый credential, пока новый не проверен. При failed health вернуть ссылку secret storage на ещё активный старый credential и перезапустить app. Если секрет выведен в log/evidence, остановить гейт, удалить доступ к артефакту и снова ротировать скомпрометированную тайну.

## 2. Явный push/staging deploy gate

**Owner:** владелец репозитория и staging; GitHub environment reviewer, если настроен.

**Prerequisites:** подписанный audit, чистое дерево, все локальные гейты зелёны, завершена staging-ротация, GitHub staging secrets настроены. Root из отдельного exact audited checkout выполнил `sudo bash scripts/bootstrap-staging-release-host.sh` (при последующих helper-only upgrade — `sudo bash scripts/install-staging-release-helpers.sh`); installer проверил единую read-only content-addressed generation `immutable-archive-v4` и только затем атомарно заменил общий `current` pointer. Release-копии из `/opt/easyboost-staging/scripts/` через `sudo` не запускаются. Host — Linux с Node.js, Docker Compose, `/usr/bin/python3`, libc с экспортом `renameat2`, kernel/filesystem с рабочим `RENAME_NOREPLACE`, GNU coreutils (`timeout`, `fallocate`, `truncate`, `sha256sum`) и `flock`; installer выполняет fail-closed syscall probe на `/tmp` до установки. `postgres:17-alpine` заранее загружен только как seed, helper фиксирует его canonical SHA256 ID и передаёт Compose именно этот immutable ID, потому что pull запрещён. Владелец явно подтверждает, что push в `production-hardening` автоматически запустит staging deploy workflow.

**Safe steps/commands:**

```powershell
$AuditCommit = git rev-parse HEAD
git status --porcelain=v1
git show --no-patch --format="%H %s" HEAD
git push --dry-run origin production-hardening
```

`$AuditCommit` должен быть равен `<AUDIT_COMMIT_SHA>`, а `git status --porcelain=v1` — пуст. Только после отдельного owner approval:

```powershell
git push origin production-hardening
```

В GitHub Actions проверить CI и `Deploy staging` для точного commit SHA. На staging выполнить:

```bash
set -euo pipefail
cd /opt/easyboost-staging
mapfile -t staging_postgres_container_ids < <(
  docker ps --no-trunc \
    --filter 'label=com.docker.compose.project=easyboost-staging' \
    --filter 'label=com.docker.compose.service=postgres' \
    --filter 'label=com.docker.compose.oneoff=False' \
    --format '{{.ID}}'
)
[[ "${#staging_postgres_container_ids[@]}" -eq 1 ]] || {
  echo 'Expected exactly one running canonical staging PostgreSQL container' >&2
  exit 1
}
staging_postgres_container_id="${staging_postgres_container_ids[0]}"
staging_postgres_identity="$(docker inspect --format '{{.Id}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.State.Running}}' "$staging_postgres_container_id")"
IFS='|' read -r staging_postgres_inspected_id EASYBOOST_STAGING_POSTGRES_IMAGE_ID \
  staging_postgres_project staging_postgres_service staging_postgres_oneoff \
  staging_postgres_running staging_postgres_extra <<< "$staging_postgres_identity"
[[ "$staging_postgres_container_id" =~ ^[0-9a-f]{64}$ ]] || exit 1
[[ "$staging_postgres_inspected_id" = "$staging_postgres_container_id" ]] || exit 1
[[ "$staging_postgres_project" = "easyboost-staging" ]] || exit 1
[[ "$staging_postgres_service" = "postgres" ]] || exit 1
[[ "$staging_postgres_oneoff" = "False" ]] || exit 1
[[ "$staging_postgres_running" = "true" ]] || exit 1
[[ -z "$staging_postgres_extra" ]] || exit 1
[[ "$EASYBOOST_STAGING_POSTGRES_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
export EASYBOOST_STAGING_POSTGRES_IMAGE_ID
docker compose -f compose.staging.yml --env-file .env.staging ps
curl --fail http://127.0.0.1:3001/health/ready
curl --fail https://staging.useboost.ru/health/ready
cat .release-sha256
```

**Evidence artifact:** owner approval, `<AUDIT_COMMIT_SHA>`, CI/deploy run URL, release archive SHA-256 from workflow and `.release-sha256`, `docker compose ps`, оба HTTP 200, UTC deploy time. Secret values and `.env.staging` are never attached.

**Success:** CI green for exact SHA, deploy job green, local and public staging readiness HTTP 200, archive checksum matches workflow, production containers/routes unchanged.

**Stop/rollback:** dirty tree, SHA mismatch, failed CI, unexpected target or failed readiness stops the gate. Never force-push or rewrite the branch. Сначала зафиксировать отдельные primary/recovery статусы helper, проверить `.release-sha256` и readiness. Если существует `.staging-recovery-required`, новый rollback запрещён: это fail-closed repair condition для ручного восстановления, а не разрешение угадывать target. Только после доказанного active state owner может явно выбрать сохранённый full SHA:

```bash
set -euo pipefail
sudo /usr/local/sbin/easyboost-staging-rollback \
  <full-release-sha256> immutable-archive-v4 \
  "$(sudo cat /usr/local/lib/easyboost-staging-release/current)"
curl --fail https://staging.useboost.ru/health/ready
```

Root-owned deploy helper принимает только versioned четырёхаргументный protocol
`RELEASE_ARCHIVE EXPECTED_SHA256 immutable-archive-v4 BUNDLE_SHA256`; обновлённый workflow поэтому не может молча
продолжить через старую двухаргументную helper-копию. Deploy и rollback копируют выбранный archive в
private temporary file, сверяют checksum, canonical USTAR/member policy и фиксированные границы
(256 MiB compressed, 4096 entries, 16 MiB per file, 384 MiB aggregate, 64 MiB disk headroom;
60/90/600 s inspect/extract/build) и строят release image прямо из этих gzip bytes до изменения active
tree. Затем stable local image запускается с `up --pull never --no-build`. Из текущего
staging-каталога сохраняются только `.env.staging`, `backups/` и `rollbacks/`; PostgreSQL остаётся в
именованном Docker volume вне code tree. Rollback принимает только explicit full SHA и exact
`rollbacks/releases/release-<sha>.tar.gz` + одно-строчный sidecar; legacy mutable-tree archives fail
closed. Общий lock охватывает build/tree/recovery. Release store ограничен четырьмя полными парами и
1 GiB без auto-prune; orphan/temp/symlink и превышение границы останавливают операцию до Docker.

Staging rollback возвращает только code tree, local image и marker. PostgreSQL schema/data никогда
автоматически не откатываются и не down-migrate: миграции должны быть backward-compatible с сохранённым
predecessor либо operator заранее готовит и отдельно подтверждает проверенный DB restore. Если checked
recovery image/tree/marker/running identity/readiness не доказан, `.staging-recovery-required` блокирует
следующую операцию до ручного восстановления; это не считается успешным rollback.

Rollback evidence is attached, defect is opened, and a new deploy always restarts the seven-day clock.

## 3. Новый 7-day soak после deploy

**Owner:** staging operator; daily evidence reviewer — владелец продукта.

**Prerequisites:** staging отдаёт exact approved candidate, деплои на время soak заморожены, timer files из этого commit установлены, выделен candidate-specific output directory. Прежние NDJSON/status архивируются как history, но не копируются в новый каталог.

**Safe steps/commands:** создать systemd drop-in для `easyboost-staging-soak.service`, где `<SHORT_SHA>` — первые 12 символов `<AUDIT_COMMIT_SHA>`:

```ini
[Service]
Environment=STAGING_SOAK_DIR=/var/lib/easyboost-staging-soak/candidate-<SHORT_SHA>
```

Затем:

```bash
set -euo pipefail
sudo systemctl stop easyboost-staging-soak.timer
sudo systemctl daemon-reload
sudo systemctl start easyboost-staging-soak.service
sudo systemctl enable --now easyboost-staging-soak.timer
systemctl status easyboost-staging-soak.timer --no-pager
cat /var/lib/easyboost-staging-soak/candidate-<SHORT_SHA>/staging-soak-status.json
```

Ежедневно проверять status, backup freshness, 5xx/AI/DB/Telegram/STT/TTS alerts и сохранность одного обезличенного test-account progress marker через UI. Не выводить user data в артефакт.

**Evidence artifact:** immutable copy of candidate-specific `staging-soak.ndjson`, final `staging-soak-status.json`, daily checklist of alert/backup/data-integrity state, exact deployed SHA/checksum and UTC interval.

**Success:** elapsed time ≥ 7 days, `failedSamples: 0`, `currentSuccess: true`, `complete: true`, all samples belong to one unchanged candidate, test marker survives, no unclassified critical/high defect or data loss.

**Stop/rollback:** any redeploy, failed sample, data-loss signal or critical/high defect invalidates this clock. Freeze evidence, rollback staging if needed, investigate, deploy a new candidate and start a new empty candidate directory from day zero.

## 4. Physical iPhone Safari и Android Chrome

**Owner:** QA/owner на физических устройствах.

**Prerequisites:** exact candidate работает на isolated HTTPS staging, есть отдельный staging test account/бот без production data, разрешены только бюджетно одобренные внешние вызовы. Подготовить physical iPhone с current Safari, отдельный iPhone/версию с previous major Safari и Android с current Chrome.

**Safe steps:** на каждой комбинации OS/browser записать точные версии, открыть staging URL в чистом profile и пройти:

1. Telegram staging-login/trial и восстановление сессии после reload.
2. Words/grammar/progress, keyboard и touch targets, portrait/landscape, safe area, zoom и отсутствие horizontal overflow.
3. Writing 37/38 и speaking UI на test data; явный allow и deny микрофона; задание и draft не теряются.
4. Потеря сети, visible typed offline state, возврат сети и синхронизация без дубля/потери.
5. Истечение subscription и logout с корректным восстановимым состоянием.

**Evidence artifact:** matrix device model / OS / browser version / scenario / pass-fail, screenshots or short video without PII/secrets, request IDs for failures, tester and UTC time.

**Success:** every scenario passes on current and previous major iPhone Safari and current Android Chrome; no data loss, overflow, blocked control or misleading error.

**Stop/rollback:** stop on data loss, cross-user data, security failure, crash loop or repeated 5xx. Capture request ID and device facts, do not retry with real user data; rollback staging candidate if regression is release-blocking.

## 5. Реальная PWA install/offline

**Owner:** QA/owner; evidence reviewer — release owner.

**Prerequisites:** physical supported device, valid staging HTTPS, exact candidate, empty test profile and completed online load of Words, Grammar and Progress. Browser emulation не считается.

**Safe steps:**

1. Android Chrome: выбрать Install app/Add to Home screen. iPhone Safari: Share → Add to Home Screen.
2. Запустить только с домашнего экрана и зафиксировать standalone UI.
3. Online открыть Words, Grammar, Progress и создать обезличенное test progress change.
4. Включить airplane mode/отключить Wi-Fi и mobile data, полностью закрыть PWA, запустить с иконки.
5. Проверить shell, ранее загруженные базовые задания, progress snapshot и очередь нового изменения; online-only actions показывают сетевую ошибку, а не старый успех.
6. Вернуть сеть, дождаться sync, reload и подтвердить ровно одно сохранённое изменение.
7. После evidence удалить PWA и test account data штатными UI/API-средствами.

**Evidence artifact:** install prompt/home-screen icon, standalone launch, offline relaunch, queued/synced state и final server-visible test marker, с device/browser versions и UTC timestamps.

**Success:** PWA реально установлена; из иконки открывает базовые задания без сети; queued progress синхронизируется один раз без потери.

**Stop/rollback:** installability failure, blank offline start, stale API success, queue loss/duplication или service-worker update loop block release. Удалить test PWA/cache с устройства, откатить staging при release regression и начать гейт заново после fix.

## 6. Внешний monitoring и доставка alerts

**Owner:** platform/monitoring operator; receiver — владелец Telegram admin channel.

**Prerequisites:** монитор работает вне process/container приложения, secure environment предоставляет `MONITORING_TOKEN`, `TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_ID`, scheduler запускает проверку каждые 5 минут, staging URL готов. Секреты не печатаются и не передаются аргументами CLI.

**Safe steps/commands:** в уже настроенном secure monitor environment:

```bash
set -euo pipefail
cd /opt/easyboost-next
npm run monitor -- --test-alert
```

Подтвердить доставку test-alert. Затем отдельным state file создать безопасный synthetic unavailable/recovery без остановки staging:

```bash
set -euo pipefail
synthetic_unavailable_status=0
MONITORING_URL=http://127.0.0.1:1 MONITORING_STATE_FILE=/var/lib/easyboost-monitor/gate-<SHORT_SHA>.json npm run monitor || synthetic_unavailable_status="$?"
[ "$synthetic_unavailable_status" -eq 1 ] || {
  echo 'Synthetic unavailable probe must fail with status 1' >&2
  exit 1
}
MONITORING_URL=https://staging.useboost.ru MONITORING_STATE_FILE=/var/lib/easyboost-monitor/gate-<SHORT_SHA>.json npm run monitor
```

Первый запуск должен доставить unavailable alert, второй — recovery. Основной production/staging state file этим не меняется.

**Evidence artifact:** scheduler status, redacted monitor log, Telegram test/unavailable/recovery messages с timestamps, target environment, candidate SHA и имя отдельного state file. Токены и chat ID не прикладываются.

**Success:** external scheduler active; все три сообщения доставлены один раз в согласованный channel; recovery не сбрасывает unrelated active incidents.

**Stop/rollback:** нет delivery за 5 минут, duplicate storm, wrong recipient или утечка значения останавливают гейт. Отключить только synthetic schedule/state, сохранив основной monitor; при exposure сразу ротировать скомпрометированный secret.

## 7. Полное recovery на втором сервере

**Owner:** administrator и owner проекта; observer фиксирует RTO/RPO.

**Prerequisites:** новый или явно изолированный второй server, не являющийся production/staging; owner-approved URL Git-репозитория и полный lowercase commit SHA, а также encrypted external backup; отдельный isolated HTTPS hostname; Git, Docker Engine, Compose v2 и `rclone`. До запуска app владелец создаёт отдельный rehearsal-only `/opt/easyboost-next/.env`: isolated `APP_URL`, новые временные `JWT_SECRET` и `POSTGRES_PASSWORD`, отключённые AI-провайдеры, пустой `TELEGRAM_BOT_TOKEN` либо отдельный recovery-бот и отдельные monitoring credentials. Production/staging `.env`, Telegram/AI tokens, JWT, database password и monitoring credentials на второй server не переносятся. Целевые RPO ≤ 24 h, RTO ≤ 4 h.

**Safe steps/commands:** перед любым изменением записать UTC start, hostname/IP, подтвердить пустой target и отсутствие production/staging routes. Это самостоятельная disaster-recovery rehearsal: staging rollback helper никогда не вызывает эти DB restore-команды. Использовать последовательность восстановления данных из `docs/DISASTER_RECOVERY.md`, но не его production `.env` и production hostname; перед запуском app ещё раз проверить только имена переменных и убедиться, что активны rehearsal-only credentials:

```bash
set -euo pipefail
: "${EASYBOOST_RELEASE_REPOSITORY:?set the owner-approved Git repository URL}"
: "${EASYBOOST_RELEASE_COMMIT:?set the owner-approved full commit SHA}"
[[ "$EASYBOOST_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || exit 1
git clone --no-checkout "$EASYBOOST_RELEASE_REPOSITORY" /opt/easyboost-next
cd /opt/easyboost-next
git fetch --no-tags origin "$EASYBOOST_RELEASE_COMMIT"
git checkout --detach "$EASYBOOST_RELEASE_COMMIT"
if git symbolic-ref -q HEAD >/dev/null; then
  echo 'Release checkout must use detached HEAD' >&2
  exit 1
else
  symbolic_ref_status="$?"
  [ "$symbolic_ref_status" -eq 1 ] || exit 1
fi
[ "$(git rev-parse --verify HEAD)" = "$EASYBOOST_RELEASE_COMMIT" ] || exit 1
[ -z "$(git status --porcelain=v1 --untracked-files=all)" ] || exit 1
npm ci
sudo install -d -o root -g root -m 0750 /var/lib/easyboost/locks
export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
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
rclone lsf gdrive:EasyBoost-Backups --files-only | sort | tail -n 5
rclone copyto gdrive:EasyBoost-Backups/easyboost-<UTC>.dump /opt/easyboost-next/backups/easyboost-restore.dump
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
postgres_preflight_image_id="$(docker image inspect --format '{{.Id}}' "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID")"
[ "$postgres_preflight_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ] || {
  echo 'PostgreSQL image identity changed before Compose start' >&2
  exit 1
}
docker compose --project-name easyboost-production -f compose.production.yml up --pull never -d postgres
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
sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/postgres-restore.js \
  /opt/easyboost-next/backups/easyboost-restore.dump --database-only --confirm-restore
# Restore физически резервирует exact archive bytes + bounded headroom до mutation. Если structured
# settlement marker или shared host guard retained, app start/release запрещены до read-only
# token/PGAPPNAME/process/pg_stat_activity recovery из README_DEPLOY.md.
export EASYBOOST_APP_READINESS_URL=https://<ISOLATED_RECOVERY_HOST>/health/ready
sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_APP_READINESS_URL,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
  /usr/bin/node scripts/production-app-lifecycle.js start
docker compose --project-name easyboost-production -f compose.production.yml exec -T postgres psql -U easyboost -d easyboost -c 'SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM user_progress; SELECT COUNT(*) FROM schema_migrations;'
```

Exact app/project/image proof, bounded isolated HTTPS readiness и failure isolation выполняются lifecycle
helper под одной host guard. При недоказанном settlement он сохраняет typed recovery authority и блокирует
следующий lifecycle/import/release до исполнимого recovery entrypoint.

`EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID` заранее переносится из owner-approved release-записи;
идентификатор, полученный самим rehearsal pull, не является источником доверия.

Проверить exact checkout HEAD/clean status до сборки, возраст backup до restore, миграции, счётчики без вывода строк с PII, изолированный HTTPS и один безопасный test-account login/flow. Telegram login, monitoring cron и test-alert проверять только с отдельными recovery credentials; если их нет, этот gate остаётся незавершённым, а production credentials не копируются. Зафиксировать UTC ready time.

**Evidence artifact:** target identity, полный release commit SHA, backup filename/age, полная timeline, exit codes, HTTP 200, обезличенные counts, migrations count, monitor delivery, measured RTO/RPO и observer sign-off. Не сохранять `.env`, backup или user rows в Git/evidence report.

**Success:** сервер поднят с нуля, backup восстановлен, counts/migrations согласованы с source evidence, app и isolated HTTPS ready, ключевой flow/cron/alert работают, RPO ≤ 24 h и RTO ≤ 4 h.

**Stop/rollback:** SHA/checksum mismatch, invalid archive, target с production/staging data/route, неожиданный existing volume, обнаруженный production/staging credential или риск PII exposure немедленно останавливают rehearsal до запуска app. Не переназначать production DNS и не трогать source server. После owner sign-off отозвать временные credentials/route; удаление rehearsal resources выполняется только по отдельному явному разрешению и с проверкой точного target.
