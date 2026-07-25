# Easy Boost — release checklist

## Автоматически проверено

- [x] Production-конфигурация требует PostgreSQL и JWT secret от 32 символов.
- [x] Docker image собирается и запускается от непривилегированного пользователя `node`.
- [x] PostgreSQL 17 проходит healthcheck; все SQL-миграции применяются автоматически.
- [x] Repository integration flow проверен на реальной PostgreSQL 17.
- [x] Chrome E2E проверяет demo, клавиатурную навигацию, слова, offline/recovery, сохранение прогресса, logout и PWA.
- [x] `/health/live` и `/health/ready` отвечают из production Compose.
- [x] Backup создаётся атомарно; restore проверяет архив и требует подтверждения.
- [x] Backup/restore rehearsal возвращает удалённую marker-запись и healthy-состояние приложения.
- [x] Проверка backup автоматически восстанавливает архив в изолированную временную БД и публикует статус для мониторинга.
- [x] Cookie-session, CSRF, CSP и отсутствие frontend-секретов покрыты regression-тестами.
- [x] Telegram updates проходят строгую серверную валидацию, а HTML в сгенерированных ИИ строках отклоняется.
- [x] Текущие файлы и полная Git-история автоматически проверяются на секреты без вывода найденных значений.
- [x] `npm audit --omit=dev` сообщает 0 известных уязвимостей.
- [x] CI запускает миграции и integration-тест с PostgreSQL 17.

## Перед первым production-запуском

- [ ] Отозвать ранее опубликованный frontend AI key и выпустить новый server-only key.
- [ ] Задать уникальные `JWT_SECRET` и `POSTGRES_PASSWORD` через secret storage платформы.
- [ ] Проверить точное совпадение `APP_URL` с публичным HTTPS origin.
- [ ] Настроить `TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_ID` и минимум один AI provider key.
- [ ] Настроить HTTPS reverse proxy и проверить forwarded protocol/IP headers.
- [ ] Настроить внешний backup storage, расписание и мониторинг неуспешных backup.
- [x] Выполнить restore rehearsal на отдельной production-like среде.
- [ ] Настроить алерты на `/health/ready`, HTTP 5xx и рост AI ошибок/таймаутов.

## Команды release gate

```bash
npm ci
npm run check
npm test
npm run test:e2e
npm run quality:check
npm audit --omit=dev
docker compose -f compose.production.yml config
docker compose -f compose.production.yml build
docker compose -f compose.production.yml up -d
curl --fail http://127.0.0.1:3000/health/ready
```

Перед публичным заявлением о методической точности дополнительно выполнить `npm run quality:release -- quality/release.json` на наборе, независимо размеченном квалифицированным преподавателем.

Релиз разрешён только после заполнения внешних production-пунктов и успешного CI на конкретном release commit.
