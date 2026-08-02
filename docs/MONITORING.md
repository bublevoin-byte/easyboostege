# Мониторинг

`GET /api/v1/admin/metrics` доступен только пользователю с ролью `admin` и возвращает:

- uptime процесса;
- общее число HTTP-запросов;
- количество и долю ответов 5xx;
- среднюю и p95 задержку;
- распределение кодов ответа и маршрутов.
- успешные и ошибочные обращения к БД, Telegram, AI, STT и TTS;
- количество фактических переключений на резервный AI/TTS-провайдер.
- число AI-запросов, prompt/completion tokens и оценочную стоимость за последние 24 часа.
- вызовы `voice_tutor_rule_extract` видны в том же AI-журнале без fetched page text; HTTP-метрики отдельно показывают fail-closed 422/503 на discovery route;
- агрегат Voice Tutor recovery без PII: `open`, `recovered`, `relapsed`, due/overdue, session count, billable voice minutes, numerator/denominator и `error_recovery_rate`;
- использование диска в байтах и процентах;
- имя, размер, возраст и свежесть последней резервной копии (порог 36 часов).

Метрики хранятся в памяти процесса и сбрасываются при перезапуске. Буфер задержек
ограничен последними 1000 запросами. В метрики не попадают имена, ответы учеников,
токены и другие персональные данные.

`error_recovery_rate = recovered / (recovered + relapsed)`: `recovered` требует проверенного
исходного transfer и успешных новых аналогов day-1/day-7; `relapsed` требует проверенного неверного
ответа хотя бы на один новый repeat item. `open`, upcoming и overdue без ответа не входят в
denominator. Для пустой наблюдаемой когорты API явно возвращает numerator `0`, denominator `0` и rate `0`.

Агрегаты `micro_check`, `initial_transfer` и `repeat_passes.day_1/day_7` публикуют только
`passed`, `observed` и вычисленный rate. Идентификаторы ученика, задания, попытки и свободный ответ в метрики не входят;
для пустой выборки каждый счётчик и rate равен `0`.

Этот endpoint предназначен для диагностики и подключения внешнего сборщика. Он не
заменяет внешний uptime-monitor и оповещения: они должны проверять `/health/ready`
и формировать алерты независимо от процесса приложения. Поэтому доступность ещё
не считается закрытым требованием до подключения внешней проверки.

Проверка `npm run db:verify-backup` восстанавливает последний архив в изолированную временную БД. Мониторинг считает результат свежим 35 дней и создаёт алерт, если проверка отсутствует, просрочена или завершилась ошибкой.

## Host-monitor и Telegram

В production задайте случайный `MONITORING_TOKEN` длиной не менее 32 символов.
Скрипт `npm run monitor` независимо проверяет `/health/ready`, получает технические
метрики через `/internal/metrics`, применяет пороги и отправляет сообщения через
существующие `TELEGRAM_BOT_TOKEN` и `ADMIN_TELEGRAM_ID`.

Состояние активных проблем сохраняется в `MONITORING_STATE_FILE`: повторные
сообщения подавляются, а после нормализации отправляется recovery-уведомление.
При недоступности приложения прежние проблемы не считаются устранёнными.

Production cron запускается каждые пять минут:

```cron
*/5 * * * * root cd /opt/easyboost-next && MONITORING_URL=http://127.0.0.1:3000 MONITORING_APP_DIR=/opt/easyboost-next MONITORING_STATE_FILE=/var/lib/easyboost-monitor/state.json /usr/bin/npm run monitor >> /var/log/easyboost-monitor.log 2>&1
```

Проверка доставки сообщения:

```bash
cd /opt/easyboost-next
MONITORING_STATE_FILE=/var/lib/easyboost-monitor/state.json npm run monitor -- --test-alert
```
