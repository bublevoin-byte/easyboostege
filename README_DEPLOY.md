# Easy Boost — развёртывание сервера на VPS

Этот бэкенд даёт: настоящие аккаунты, хранение прогресса на сервере и прокси к Gemini (ключ спрятан на сервере, в браузер не попадает). Он же отдаёт само приложение (PWA).

## Что внутри папки `server/`
- `server.js` — сам сервер (Express).
- `db.js` — хранилище (файл `data.json`, создастся сам).
- `package.json` — зависимости.
- `.env.example` — образец настроек (скопировать в `.env`).
- `public/` — сюда положить приложение как `index.html` (см. шаг 4).

## ИИ: xAI (Grok)
Приложение использует **xAI / Grok** (OpenAI-совместимый). Ключ (`xai-...`) из console.x.ai → API Keys кладётся в `.env` как `XAI_API_KEY` и лежит только на сервере — в браузер не попадает. Модель по умолчанию `grok-4.5` (можно поменять в `.env` через `XAI_MODEL`). Grok платный — расходует баланс твоего аккаунта xAI.

---

## Шаги развёртывания

### 1. Домен
Купить домен, в его DNS указать **A-запись** на IP твоего VPS. Подождать, пока обновится (до нескольких часов).

### 2. Подключиться к VPS и поставить нужное
```bash
ssh root@ТВОЙ_IP
apt update && apt -y upgrade
# Node.js LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt -y install nodejs nginx
npm i -g pm2
```

### 3. Загрузить папку server на сервер
С компьютера (из папки проекта):
```bash
scp -r server root@ТВОЙ_IP:/opt/easyboost
```
(или через git — как удобнее).

### 4. Положить приложение внутрь
На сервере:
```bash
mkdir -p /opt/easyboost/public
# скопируй Easy_Boost.html в public как index.html:
cp /путь/к/Easy_Boost.html /opt/easyboost/public/index.html
```
(Файл `Easy_Boost.html` — из папки проекта. После подключения клиента к серверу — см. следующий этап — он будет брать данные и ИИ с сервера.)

### 5. Настройки и запуск
```bash
cd /opt/easyboost
cp .env.example .env
nano .env          # впиши JWT_SECRET (любая длинная строка) и XAI_API_KEY (xai-...)
npm install
pm2 start server.js --name easyboost
pm2 save
pm2 startup        # выполни команду, которую он подскажет — для автозапуска
```
Проверка: `curl http://localhost:3000` должен вернуть страницу.

### 6. Nginx + HTTPS
Создай конфиг:
```bash
nano /etc/nginx/sites-available/easyboost
```
Вставь (замени домен):
```
server {
    server_name твойдомен.ru;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
Включи и выпусти сертификат:
```bash
ln -s /etc/nginx/sites-available/easyboost /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
apt -y install certbot python3-certbot-nginx
certbot --nginx -d твойдомен.ru
```
Готово — открой `https://твойдомен.ru`.

---

## API (что умеет сервер)
- `POST /api/register` `{username, password}` → `{token, username}`
- `POST /api/login` `{username, password}` → `{token, username}`
- `GET  /api/progress` (заголовок `Authorization: Bearer <token>`) → прогресс
- `POST /api/progress` `{...прогресс...}` → сохранить
- `POST /api/ai` `{system, user}` → `{text}` (ключ xAI берётся на сервере)

## Дальнейшие этапы
- **Подключить клиент к серверу** (следующий этап): в приложении заменить прямые вызовы Google и локальные аккаунты на эти эндпоинты. Тогда прогресс синхронизируется между устройствами, а ключ уйдёт с клиента.
- **Telegram-вход** (Этап 4): добавить бота и эндпоинт подтверждения.
- **Переезд на PostgreSQL** при росте числа пользователей (интерфейс в `db.js` тот же).

## Безопасность (минимум)
- Обязательно длинный случайный `JWT_SECRET`.
- HTTPS (сделали через certbot).
- Регулярно копируй `data.json` (это вся база).
