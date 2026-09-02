# Администрирование Telegram-бота

1. Хранить `TELEGRAM_BOT_TOKEN` и `ADMIN_TELEGRAM_ID` только в production `.env`; не отправлять их в чат и не добавлять в Git.
2. После изменения настроек перезапустить приложение и проверить `/health/ready`.
3. Проверить вход тестового пользователя: запросить одноразовый код в приложении, подтвердить его через бота и убедиться, что повторное использование кода невозможно.
4. Административные команды выполнять только из аккаунта с `ADMIN_TELEGRAM_ID`. При смене администратора сначала обновить переменную, затем перезапустить приложение и проверить отказ старому аккаунту.
5. При компрометации токена перевыпустить его через BotFather, заменить значение на сервере, перезапустить приложение и проверить логи без публикации токена.
6. При сбое сохранить время события и безопасный `requestId`, затем проверить статус процесса бота и журналы сервиса. Пользовательские cookie, пароли и токены в обращение не включать.

## Реальный E2E на staging

Для проверки нужен отдельный бот, созданный через `@BotFather`. Production-токен
нельзя использовать на staging: Telegram разрешает только один активный
`getUpdates` consumer для одного токена, поэтому два окружения будут мешать друг
другу.

В `/opt/easyboost-staging/.env.staging` должны быть заданы:

```dotenv
APP_URL=https://staging.useboost.ru
TELEGRAM_BOT_TOKEN=<отдельный staging token>
ADMIN_TELEGRAM_ID=<Telegram ID тестового администратора или пусто>
```

Токен вводится только непосредственно на VPS и не публикуется в чате, GitHub
Actions или командной истории. Изменение code/image выполняется только SHA-256-verified
`immutable-archive-v4` workflow через
root-owned `easyboost-staging-deploy`; raw staging build запрещён. После изменения только
`.env.staging` используйте только установленный root-owned restart helper. Он разделяет lock с
deploy/rollback/import/restore, проверяет неизменный active marker и точный stable image, запускает
только app без зависимостей и возвращает успех лишь после `/health/ready`:

Общий host-operation guard всегда использует
`EASYBOOST_HOST_OPERATION_LOCK_DIR=/var/lib/easyboost/locks/host-operation.lock`. Bootstrap создаёт
только parent `/var/lib/easyboost/locks` как `root:root` с mode `0750`; сам
`host-operation.lock` заранее создавать нельзя. Все меняющие host staging/production entrypoint
запускаются через `sudo`/root, чтобы один непривилегированный владелец parent не мог подменить
чужой lock.

```bash
sudo /usr/local/sbin/easyboost-staging-restart "$(sudo cat /usr/local/lib/easyboost-staging-release/current)"
```

Если readiness не подтверждён, helper сохраняет
`/opt/easyboost-staging/.staging-recovery-required`; не удаляйте marker и не повторяйте raw-команды —
сначала разберите защищённые журналы на VPS и восстановите рабочую конфигурацию.

Затем на локальной машине:

```bash
npm run test:telegram:staging
```

Сценарий:

1. отказывается работать с production URL;
2. проверяет readiness staging;
3. создаёт одноразовый код и показывает ссылку staging-бота;
4. ждёт нажатия Start пользователем;
5. проверяет cookie-сессию и невозможность повторного использования кода;
6. ждёт активации пробного периода и проверяет доступ через `/api/v1/me`.

Для повторной проверки аккаунта с уже активным доступом шаг пробного периода
завершится сразу. Если проверяется только вход, можно задать
`TELEGRAM_E2E_SKIP_TRIAL=1`.
