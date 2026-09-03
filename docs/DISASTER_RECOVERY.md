# Аварийное восстановление Easy Boost

## Целевые показатели — не подтверждённые гарантии

- RPO: цель — не более 24 часов; до настройки и свежей проверки off-host backup, расписания, age-monitoring
  и failure-alert это не является текущей гарантией.
- RTO: не более 4 часов с момента подтверждения аварии до доступного `/health/ready`.

Внешнее backup-хранилище, ежедневное расписание и мониторинг сейчас не подтверждены current release evidence.
Пока пункт release checklist не закрыт, RPO считается недоступным, а аварийный release остаётся заблокированным.
После owner-подтверждения off-host authority перед восстановлением выбирается последний полный архив
`easyboost-*.dump` и отдельно проверяется его возраст.

## Порядок восстановления

1. Подготовить VPS с Git, Docker Engine, Docker Compose v2, `rclone` и доступом к Google Drive.
2. Получить из owner-approved release-записи URL Git-репозитория и полный lowercase commit SHA.
   Branch, tag, сокращённый SHA и распакованное дерево без `.git` не являются release authority.
3. Создать exact detached checkout и только затем восстановить production `.env` из защищённого
   хранилища:

   ```bash
   set -euo pipefail
   : "${EASYBOOST_RELEASE_REPOSITORY:?set the owner-approved Git repository URL}"
   : "${EASYBOOST_RELEASE_COMMIT:?set the owner-approved full commit SHA}"
   [[ "$EASYBOOST_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
     echo 'Release commit must be a full canonical lowercase identity' >&2
     exit 1
   }
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
   install -d -m 0700 backups
   sudo install -d -o root -g root -m 0750 /var/lib/easyboost/locks
   export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
   # Теперь восстановить production .env из защищённого хранилища.
   ```
4. Скачать последний внешний backup:

   ```bash
   set -euo pipefail
   rclone lsf gdrive:EasyBoost-Backups --files-only | sort | tail -n 5
   rclone copyto \
     gdrive:EasyBoost-Backups/easyboost-YYYY-MM-DDTHH-MM-SS-mmmZ.dump \
     /opt/easyboost-next/backups/easyboost-restore.dump
   ```

5. Собрать приложение, закрепить его exact image ID, затем поднять только PostgreSQL и дождаться readiness:

   ```bash
   set -euo pipefail
   cd /opt/easyboost-next
   if git symbolic-ref -q HEAD >/dev/null; then
     echo 'Release checkout must use detached HEAD' >&2
     exit 1
   else
     symbolic_ref_status="$?"
     [ "$symbolic_ref_status" -eq 1 ] || exit 1
   fi
   [ "$(git rev-parse --verify HEAD)" = "$EASYBOOST_RELEASE_COMMIT" ] || exit 1
   [ -z "$(git status --porcelain=v1 --untracked-files=all)" ] || exit 1
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
   ```

   Ожидаемый ID берётся из owner-approved release-записи до pull; значение, увиденное после pull,
   не становится доверенным автоматически.

6. Проверить архив и восстановить базу через единый locked/frozen/supervised database-only interface.
   До его успешного завершения Compose app allocation обязан отсутствовать:

   ```bash
   set -euo pipefail
   : "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the image ID approved in step 5}"
   export EASYBOOST_PRODUCTION_APP_IMAGE_ID
   : "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
   export EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
   export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
   sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
     /usr/bin/node scripts/postgres-restore.js \
     /opt/easyboost-next/backups/easyboost-restore.dump --database-only --confirm-restore
   ```

   Wrapper под root-owned shared host guard физически резервирует exact archive bytes и bounded headroom
   на host и в container staging, доказывает immutable PostgreSQL ID/image/labels/state и запускает
   tokenized supervisor с exact `PGAPPNAME`. Общий DB lock не освобождается, пока одновременно не доказаны
   отсутствие tokenized remote process и matching `pg_stat_activity`. Неподтверждённый settlement сохраняет
   structured recovery marker и host guard; приложение, import и release после него запускать нельзя.

   Если marker retained, не удалять, не переименовывать и не копировать его или host guard по
   PID/возрасту. Полная процедура settlement и снятия exact typed authorities описана в
   `README_DEPLOY.md`, «Retained restore marker», и выполняется только executable helper:

   ```bash
   set -euo pipefail
   : "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the image ID approved in step 5}"
   : "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
   export EASYBOOST_PRODUCTION_APP_IMAGE_ID EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID
   export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
   sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
     /usr/bin/node scripts/production-restore-recovery.js
   ```

   Helper принимает только совпадающие typed DB/host evidence, exact project/service/container/image
   authority и доказанный stopped container либо bounded process/activity/process sandwich. Даже после
   успешного recovery partial restore не становится валидной базой: приложение оставить absent и
   повторить полный database-only restore из проверенного архива.

7. Запустить приложение из закреплённого на шаге 5 immutable image ID:

   ```bash
   set -euo pipefail
   if git symbolic-ref -q HEAD >/dev/null; then
     echo 'Release checkout must use detached HEAD' >&2
     exit 1
   else
     symbolic_ref_status="$?"
     [ "$symbolic_ref_status" -eq 1 ] || exit 1
   fi
   [ "$(git rev-parse --verify HEAD)" = "$EASYBOOST_RELEASE_COMMIT" ] || exit 1
   [ -z "$(git status --porcelain=v1 --untracked-files=all)" ] || exit 1
   : "${EASYBOOST_PRODUCTION_APP_IMAGE_ID:?set the image ID approved in step 5}"
   production_app_image_id="$EASYBOOST_PRODUCTION_APP_IMAGE_ID"
   [[ "$production_app_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
     echo 'Approved application image ID is not canonical' >&2
     exit 1
   }
   app_preflight_image_id="$(docker image inspect --format '{{.Id}}' "$production_app_image_id")"
   [ "$app_preflight_image_id" = "$production_app_image_id" ] || {
     echo 'Approved application image is unavailable before recovery start' >&2
     exit 1
   }
   export EASYBOOST_PRODUCTION_APP_IMAGE_ID="$production_app_image_id"
   : "${EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID:?set the owner-approved PostgreSQL sha256 image ID}"
   [[ "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
     echo 'PostgreSQL image ID must be a full canonical sha256 identity' >&2
     exit 1
   }
   postgres_container_id="$(docker compose --project-name easyboost-production -f compose.production.yml ps -q postgres)"
   [ -n "$postgres_container_id" ] || { echo 'Running PostgreSQL container is missing' >&2; exit 1; }
   postgres_running_image_id="$(docker inspect --format '{{.Image}}' "$postgres_container_id")"
   [ "$postgres_running_image_id" = "$EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID" ] || {
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
   export EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock
   export EASYBOOST_APP_READINESS_URL=https://useboost.ru/health/ready
   sudo --preserve-env=EASYBOOST_HOST_OPERATION_LOCK_DIR,EASYBOOST_APP_READINESS_URL,EASYBOOST_PRODUCTION_APP_IMAGE_ID,EASYBOOST_POSTGRES_EXPECTED_IMAGE_ID \
     /usr/bin/node scripts/production-app-lifecycle.js start
   ```

   Exact app/project/image proof, bounded public readiness и failure isolation выполняются lifecycle helper
   под одной host guard. При недоказанном settlement он сохраняет typed recovery authority и не разрешает
   следующий lifecycle/import/release.

8. Проверить количество пользователей, прогресс и миграции:

   ```bash
   set -euo pipefail
   docker compose --project-name easyboost-production -f compose.production.yml exec -T postgres \
     psql -U easyboost -d easyboost -c \
     'SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM user_progress; SELECT COUNT(*) FROM schema_migrations;'

   ```

9. Восстановить cron-задачи backup и мониторинга, проверить Telegram test-alert.

## Бюджет RTO

| Этап | Максимальный бюджет |
|---|---:|
| Создание или доступ к VPS | 45 минут |
| Docker, rclone и системная настройка | 45 минут |
| Release, secrets и Cloudflare tunnel | 45 минут |
| Загрузка и восстановление БД | 30 минут |
| Проверка приложения и данных | 30 минут |
| Резерв на диагностику | 45 минут |
| **Итого** | **4 часа** |

Отсчёт начинается после подтверждения аварии. Если этап превышает свой бюджет, администратор сообщает о нарушении RTO и фиксирует причину.

## Результат исторической тренировки 25 июля 2026 года — не является current release evidence

- источник: Google Drive, `easyboost-2026-07-25T03-15-03-531Z.dump`;
- стенд: отдельный Compose project, отдельная сеть, volume и PostgreSQL, порт `127.0.0.1:3001`;
- восстановлено: 3 пользователя, 3 записи прогресса, 16 миграций;
- readiness тренировочного стенда: HTTP 200;
- measured technical RTO от начала скачивания backup до readiness: **17 секунд**;
- production во время тренировки: локальный и публичный HTTP 200;
- после проверки тренировочные контейнеры, сеть, volume и временные secrets удалены.

Измерение подтверждает этапы загрузки, восстановления, сборки и запуска на уже подготовленном VPS. Оно не измеряет выдачу нового VPS, восстановление DNS/Cloudflare и получение secrets от владельца. Для полной проверки потери хоста требуется отдельная тренировка на втором сервере.
