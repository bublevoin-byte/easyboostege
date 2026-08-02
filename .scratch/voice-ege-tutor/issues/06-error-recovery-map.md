# 06 — Карта освоенных ошибок и возвращённых баллов

**What to build:** после voice/text-разбора ученик видит структурированную карту навыков: какие ошибки разобраны, пройден ли micro-check, выдержан ли перенос через 1/7 дней и какие типы ошибок сильнее всего влияют на потенциальный результат ЕГЭ.

**Blocked by:** 03 — Чтение/аудирование; 04 — Письмо/устная часть; 05 — Trusted rules.

**Status:** ready-for-agent

- [ ] Session outcome хранит только структурированные поля без raw audio/full transcript.
- [ ] Повтор через 1 и 7 дней привязан к skill и не считается пройденным по исходному примеру.
- [ ] API карты отдаёт server-owned aggregates текущего пользователя и не раскрывает чужие данные.
- [ ] UI показывает recovered/open/relapsed skills, voice minutes и следующий полезный разбор.
- [ ] `error_recovery_rate` вычисляется детерминированно и доступен в metrics без PII.
- [ ] Targeted tests, `npm run lint`, `npm run check` и `npm test` проходят.

