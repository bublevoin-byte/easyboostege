# Аварийное восстановление Easy Boost

## Цели

- RPO: не более 24 часов.
- RTO: не более 4 часов с момента подтверждения аварии до доступного `/health/ready`.

Внешние PostgreSQL-копии ежедневно загружаются в `gdrive:EasyBoost-Backups`. Перед восстановлением необходимо выбрать последний полный архив `easyboost-*.dump`.

## Порядок восстановления

1. Подготовить VPS с Docker Engine, Docker Compose v2, `rclone` и доступом к Google Drive.
2. Получить проверенный release-архив приложения и сверить его SHA-256.
3. Создать `/opt/easyboost-next`, распаковать release и восстановить production `.env` из защищённого хранилища.
4. Скачать последний внешний backup:

   ```bash
   rclone lsf gdrive:EasyBoost-Backups --files-only | sort | tail -n 5
   rclone copyto \
     gdrive:EasyBoost-Backups/easyboost-YYYY-MM-DDTHH-MM-SS-mmmZ.dump \
     /opt/easyboost-next/backups/easyboost-restore.dump
   ```

5. Поднять только PostgreSQL и дождаться readiness:

   ```bash
   cd /opt/easyboost-next
   docker compose -f compose.production.yml up -d postgres
   docker compose -f compose.production.yml exec -T postgres \
     pg_isready -U easyboost -d easyboost
   ```

6. Проверить архив и восстановить базу:

   ```bash
   docker compose -f compose.production.yml exec -T postgres \
     pg_restore --list < backups/easyboost-restore.dump

   docker compose -f compose.production.yml exec -T postgres \
     pg_restore -U easyboost -d easyboost \
     --no-owner --no-privileges --exit-on-error \
     < backups/easyboost-restore.dump
   ```

7. Собрать и запустить приложение:

   ```bash
   docker compose -f compose.production.yml up -d --build app
   curl --fail http://127.0.0.1:3000/health/ready
   ```

8. Проверить количество пользователей, прогресс и миграции, затем публичный HTTPS:

   ```bash
   docker compose -f compose.production.yml exec -T postgres \
     psql -U easyboost -d easyboost -c \
     'SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM user_progress; SELECT COUNT(*) FROM schema_migrations;'

   curl --fail https://useboost.ru/health/ready
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

## Результат тренировки 25 июля 2026 года

- источник: Google Drive, `easyboost-2026-07-25T03-15-03-531Z.dump`;
- стенд: отдельный Compose project, отдельная сеть, volume и PostgreSQL, порт `127.0.0.1:3001`;
- восстановлено: 3 пользователя, 3 записи прогресса, 16 миграций;
- readiness тренировочного стенда: HTTP 200;
- measured technical RTO от начала скачивания backup до readiness: **17 секунд**;
- production во время тренировки: локальный и публичный HTTP 200;
- после проверки тренировочные контейнеры, сеть, volume и временные secrets удалены.

Измерение подтверждает этапы загрузки, восстановления, сборки и запуска на уже подготовленном VPS. Оно не измеряет выдачу нового VPS, восстановление DNS/Cloudflare и получение secrets от владельца. Для полной проверки потери хоста требуется отдельная тренировка на втором сервере.
