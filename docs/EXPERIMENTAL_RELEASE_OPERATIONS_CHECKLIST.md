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
4. Проверить среду без вывода env:

   ```bash
   docker compose -f compose.production.yml up -d app
   curl --fail http://127.0.0.1:3000/health/live
   curl --fail http://127.0.0.1:3000/health/ready
   docker compose -f compose.production.yml logs --tail=100 app
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

**Prerequisites:** подписанный audit, чистое дерево, все локальные гейты зелёны, завершена staging-ротация, GitHub staging secrets настроены. Root отдельно проверил исходники deploy и rollback и установил неизменяемые копии `/usr/local/sbin/easyboost-staging-deploy` и `/usr/local/sbin/easyboost-staging-rollback`; release-копии из `/opt/easyboost-staging/scripts/` через `sudo` не запускаются. Владелец явно подтверждает, что push в `production-hardening` автоматически запустит staging deploy workflow.

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
cd /opt/easyboost-staging
docker compose -f compose.staging.yml --env-file .env.staging ps
curl --fail http://127.0.0.1:3001/health/ready
curl --fail https://staging.useboost.ru/health/ready
cat .release-sha256
```

**Evidence artifact:** owner approval, `<AUDIT_COMMIT_SHA>`, CI/deploy run URL, release archive SHA-256 from workflow and `.release-sha256`, `docker compose ps`, оба HTTP 200, UTC deploy time. Secret values and `.env.staging` are never attached.

**Success:** CI green for exact SHA, deploy job green, local and public staging readiness HTTP 200, archive checksum matches workflow, production containers/routes unchanged.

**Stop/rollback:** dirty tree, SHA mismatch, failed CI, unexpected target or failed readiness stops the gate. Never force-push or rewrite the branch. If staging was changed and readiness failed:

```bash
sudo /usr/local/sbin/easyboost-staging-rollback
curl --fail https://staging.useboost.ru/health/ready
```

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
cd /opt/easyboost-next
npm run monitor -- --test-alert
```

Подтвердить доставку test-alert. Затем отдельным state file создать безопасный synthetic unavailable/recovery без остановки staging:

```bash
MONITORING_URL=http://127.0.0.1:1 MONITORING_STATE_FILE=/var/lib/easyboost-monitor/gate-<SHORT_SHA>.json npm run monitor
MONITORING_URL=https://staging.useboost.ru MONITORING_STATE_FILE=/var/lib/easyboost-monitor/gate-<SHORT_SHA>.json npm run monitor
```

Первый запуск должен доставить unavailable alert, второй — recovery. Основной production/staging state file этим не меняется.

**Evidence artifact:** scheduler status, redacted monitor log, Telegram test/unavailable/recovery messages с timestamps, target environment, candidate SHA и имя отдельного state file. Токены и chat ID не прикладываются.

**Success:** external scheduler active; все три сообщения доставлены один раз в согласованный channel; recovery не сбрасывает unrelated active incidents.

**Stop/rollback:** нет delivery за 5 минут, duplicate storm, wrong recipient или утечка значения останавливают гейт. Отключить только synthetic schedule/state, сохранив основной monitor; при exposure сразу ротировать скомпрометированный secret.

## 7. Полное recovery на втором сервере

**Owner:** administrator и owner проекта; observer фиксирует RTO/RPO.

**Prerequisites:** новый или явно изолированный второй server, не являющийся production/staging; owner-approved доступ к защищённому release archive и encrypted external backup; отдельный isolated HTTPS hostname; Docker Engine, Compose v2 и `rclone`. До запуска app владелец создаёт отдельный rehearsal-only `/opt/easyboost-next/.env`: isolated `APP_URL`, новые временные `JWT_SECRET` и `POSTGRES_PASSWORD`, отключённые AI-провайдеры, пустой `TELEGRAM_BOT_TOKEN` либо отдельный recovery-бот и отдельные monitoring credentials. Production/staging `.env`, Telegram/AI tokens, JWT, database password и monitoring credentials на второй server не переносятся. Целевые RPO ≤ 24 h, RTO ≤ 4 h.

**Safe steps/commands:** перед любым изменением записать UTC start, hostname/IP, подтвердить пустой target и отсутствие production/staging routes. Использовать последовательность восстановления данных из `docs/DISASTER_RECOVERY.md`, но не его production `.env` и production hostname; перед запуском app ещё раз проверить только имена переменных и убедиться, что активны rehearsal-only credentials:

```bash
rclone lsf gdrive:EasyBoost-Backups --files-only | sort | tail -n 5
rclone copyto gdrive:EasyBoost-Backups/easyboost-<UTC>.dump /opt/easyboost-next/backups/easyboost-restore.dump
cd /opt/easyboost-next
docker compose -f compose.production.yml up -d postgres
docker compose -f compose.production.yml exec -T postgres pg_isready -U easyboost -d easyboost
docker compose -f compose.production.yml exec -T postgres pg_restore --list < backups/easyboost-restore.dump
docker compose -f compose.production.yml exec -T postgres pg_restore -U easyboost -d easyboost --no-owner --no-privileges --exit-on-error < backups/easyboost-restore.dump
docker compose -f compose.production.yml up -d --build app
curl --fail http://127.0.0.1:3000/health/ready
docker compose -f compose.production.yml exec -T postgres psql -U easyboost -d easyboost -c 'SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM user_progress; SELECT COUNT(*) FROM schema_migrations;'
curl --fail https://<ISOLATED_RECOVERY_HOST>/health/ready
```

Проверить release archive SHA-256 до распаковки, возраст backup до restore, миграции, счётчики без вывода строк с PII, изолированный HTTPS и один безопасный test-account login/flow. Telegram login, monitoring cron и test-alert проверять только с отдельными recovery credentials; если их нет, этот gate остаётся незавершённым, а production credentials не копируются. Зафиксировать UTC ready time.

**Evidence artifact:** target identity, release SHA-256, backup filename/age, полная timeline, exit codes, HTTP 200, обезличенные counts, migrations count, monitor delivery, measured RTO/RPO и observer sign-off. Не сохранять `.env`, backup или user rows в Git/evidence report.

**Success:** сервер поднят с нуля, backup восстановлен, counts/migrations согласованы с source evidence, app и isolated HTTPS ready, ключевой flow/cron/alert работают, RPO ≤ 24 h и RTO ≤ 4 h.

**Stop/rollback:** SHA/checksum mismatch, invalid archive, target с production/staging data/route, неожиданный existing volume, обнаруженный production/staging credential или риск PII exposure немедленно останавливают rehearsal до запуска app. Не переназначать production DNS и не трогать source server. После owner sign-off отозвать временные credentials/route; удаление rehearsal resources выполняется только по отдельному явному разрешению и с проверкой точного target.
