# Повторный локальный аудит экспериментального релиза

- Дата: **2 августа 2026 года**.
- Зафиксированный application candidate: **`661a98974aac7bbc69dc321a876eacee65ec9819`**
  (`Make PostgreSQL integration reproducible`).
- Режим: бесплатные локальные проверки без push, deploy, staging/production data, платных ИИ-вызовов,
  ротации секретов, физических устройств, внешних alerts и второго сервера.

## Вывод

Все обязательные локальные гейты кандидата прошли. Полный Docker-независимый набор содержит 425 тестов:
424 проходят, 1 PostgreSQL-тест защитно пропущен. Обязательный выделенный PostgreSQL-контур отдельно прошёл `1/1`,
`0` skip, применил миграции `001`–`020` и удалил контейнер, сеть и volume. Такой результат закрывает §24.4.

Объединённая карта server-owned контрактов content, writing, speaking, format repair, STT и TTS прошла `58/58`
целевых тестов без skip. Каждая успешная операция имеет серверный parser, а malformed ответ не выдаётся за успех.
Это закрывает §24.10. Все остальные применимые P0 подтверждены тестами, поэтому §24.1 получает
`experimental=done`. В strict критерий 1 остаётся открыт: §11 по-прежнему `0/28`, а §24.12 — strict-open/experimental-excluded.

Результат не является разрешением на production. Восемь применимых experimental-пунктов остаются открытыми:
ротация ранее использовавшихся секретов, два физических браузера и критерии §24.5, §24.14, §24.15, §24.16 и §24.18.

## Выполненные команды

На Windows команды npm вызывались через `npm.cmd`: это тот же npm CLI без заблокированной PowerShell-обёртки `npm.ps1`.

| Команда | Exit | Точный результат |
|---|---:|---|
| `npm run lint` | 1 | Первый literal-вызов не запустил ESLint: системная PowerShell ExecutionPolicy заблокировала `npm.ps1` (`PSSecurityException`). |
| `npm.cmd run lint` | 0 | ESLint завершён без ошибок. |
| `npm.cmd run check` | 0 | Все перечисленные Node.js-файлы синтаксически валидны; 144 inline-handler (17 в разметке, 127 runtime), 104 имени разрешаются. |
| `npm.cmd test` | 0 | 425 tests: 424 pass, 0 fail, 1 protective PostgreSQL skip. |
| `npm.cmd run test:postgres` | 1 | Первая попытка не получила доступ к Docker named pipe в sandbox; test не выполнился, cleanup не мог обратиться к daemon. Успехом не считается. |
| `npm.cmd run test:postgres` (с доступом к Docker Desktop) | 0 | PostgreSQL 17 healthy; migrations `001`–`020`; repository integration 1/1 pass, 0 fail, 0 skip; test-container, network и volume удалены. |
| `npm.cmd run test:e2e` (до build) | 0 | Chromium/desktop обслуживал `public/`: critical user flows passed, responsive matrix 320–1440 px без horizontal overflow. |
| `npm.cmd run test:e2e:firefox` | 0 | Firefox/desktop: те же critical user flows passed. |
| `npm.cmd run test:e2e:android` | 0 | Chromium/Android profile: те же critical user flows passed. |
| `npm.cmd run test:e2e:iphone-webkit` | 0 | WebKit/iPhone profile: те же critical user flows passed. |
| `npm.cmd run test:e2e:performance` | 0 | LCP 88/2500 ms; CLS 0.000/0.1; INP 104/200 ms; first JS 54.5/150 KiB; AI indicator 86/200 ms. |
| `npm.cmd run build:frontend` | 0 | 17 verified assets; shell — 1 file и 164.9 KiB JavaScript; 5 lazy chunks. |
| `npm.cmd run test:e2e` (после build, во время review) | 0 | Chromium/desktop обслуживал production-bound `dist/public`: все critical user flows и responsive matrix 320–1440 px прошли повторно. После fixed candidate менялись только документы. |
| `npm.cmd run security:secrets` | 0 | 294 tracked files checked; no matches. |
| `npm.cmd run security:history` | 0 | 235 commits checked; no matches. |
| `node --test test/content-ai.test.js test/writing.test.js test/speaking-ai.test.js test/ai-format-repair.test.js test/media-provider-contracts.test.js` | 0 | 58 tests: 58 pass, 0 fail, 0 skip. |
| `npm.cmd run quality:check` | 0 | Engineering smoke: 3 cases, 6 runs, schemaPassRate 100%, gate pass; exactScoreRate 83.33%, MAE 0.1667. Это не золотой набор и не доказательство §11. |
| `npm.cmd run tz:readiness -- "<внешний-ТЗ>" --open` | 0 | До отметок аудита: strict 437/477 = 91.6%, 40 open, 0 excluded. |
| `npm.cmd run tz:readiness -- "<внешний-ТЗ>" --profile experimental --open` | 0 | До отметок аудита: experimental 437/448 = 97.5%, 11 open, 29 excluded. |
| Те же две readiness-команды после точечных отметок §24 | 0 / 0 | strict 439/477 = 92.0%, 38 open, 0 excluded; experimental 440/448 = 98.2%, 8 open, 29 excluded. |

`npm audit` намеренно не запускался. В предыдущем аудите npm registry был недоступен; сетевые права не расширялись.
Критерий §24.3 сохранил прежнюю отметку, но этот аудит не является его новым доказательством.

## Карта строгих ответов ИИ и media

| Группа | Server-owned seam | Целевое доказательство |
|---|---|---|
| Content | `ai/content.js`: strict request union, серверные instructions и output schemas для 19 операций | `test/content-ai.test.js`: 10 grouped positive/negative tests покрывают dictionary, vocabulary, grammar, reading, listening, writing-task и speaking-task parsers. |
| Writing | `ai/writing.js`: strict request, server prompt, score/criteria parser для 37/38 | `test/writing.test.js`: 16 tests для схемы, максимумов, сумм, объёма и программных правил. |
| Speaking | `ai/speaking.js`: strict evaluation/sample contracts, maxima и 4/3/3 | `test/speaking-ai.test.js`: 6 tests для assignment, prompt isolation, score totals, task 4, sample и HTML rejection. |
| Format repair | `ai/format-repair.js` и публичные AI routes: не более одной попытки, тот же parser после repair | `test/ai-format-repair.test.js`: 12 route-level tests, включая repeat failure и запрет частичного успеха. |
| STT/TTS | `routes/media.js` и `audio/controls.js`: bounded strict JSON для STT, HTTP/content-type/size для TTS и тот же buffer guard для fallback | `test/media-provider-contracts.test.js`: 14 positive/negative tests; malformed, unexpected, empty, wrong type/duration/content-type/size не становятся успехом и не кэшируются. |

Всего: **58/58 pass, 0 fail, 0 skip**. Карта покрывает content/writing/speaking/STT/TTS, а format-repair доказывает, что схема
не обходится при повторе. Это transport/structure-доказательство §24.10, а не методическая точность §11.

## Решение по §24

| Критерий | Решение аудита | Основание / что осталось |
|---:|---|---|
| 1 | Strict-open, experimental-done | Все применимые experimental P0 подтверждены картой контрактов, полными API/E2E и локальными гейтами. Strict не получает подмену вместо §11. |
| 2 | Без изменения, выполнен | В tracker нет известных critical/high; все локальные гейты зелёны. |
| 3 | Без изменения | `npm audit` не запускался из-за сохранённого сетевого ограничения; нового доказательства нет. |
| 4 | Выполнен для обоих | lint/check, 425-test suite, disposable PostgreSQL 1/1 без skip, с cleanup, четыре functional E2E-профиля, Chromium до и после build, performance, build, secret scans, 58 schema-tests и quality smoke прошли. |
| 5 | Открыт | Текущий кандидат не развёрнут. Новый 7-day soak начинается только после owner-approved staging deploy. |
| 6–9 | Без изменения | Ранее закрыты доказательствами ТЗ. |
| 10 | Выполнен для обоих | Карта content/writing/speaking/STT/TTS и 58/58 tests подтверждают строгий server-owned разбор всех успешных ответов. |
| 11 | Без изменения, выполнен | Невалидная writing-оценка не сохраняется. |
| 12 | Strict-open, experimental-excluded | §11 остаётся 0/28; engineering smoke не заменяет золотой набор. |
| 13 | Без изменения, выполнен | Предупреждение об ориентировочной оценке покрыто тестами. |
| 14 | Открыт | Нужны physical iPhone Safari и Android Chrome; browser profiles не засчитаны. |
| 15 | Открыт | Offline shell/tasks прошли в E2E, но реальная установка PWA и offline launch на физическом устройстве не выполнены. |
| 16 | Открыт | Локальная alert-логика покрыта, но нет факта внешней доставки alert/recovery для кандидата. |
| 17 | Без изменения, выполнен | Процедура rollback документирована. |
| 18 | Открыт | Нужно полное восстановление сервиса и backup на втором сервере с RTO/RPO evidence. |

## Воспроизводимая готовность

```powershell
npm.cmd run tz:readiness -- "C:\Users\Ригер\Desktop\Repetotor\ТЗ_подготовка_Easy_Boost_к_продакшену.md" --open
npm.cmd run tz:readiness -- "C:\Users\Ригер\Desktop\Repetotor\ТЗ_подготовка_Easy_Boost_к_продакшену.md" --profile experimental --open
```

- `strict`: **439/477 = 92.0%**, 38 open, 0 excluded.
- `experimental`: **440/448 = 98.2%**, 8 open, 29 excluded.
- В §11: **0/28** и ни одной отметки о выполнении.
- Из 29 excluded: 28 пунктов §11 и §24.12; исключение не равно выполнению.

Оставшиеся manual gates в безопасном порядке, с owner, prerequisites, commands, evidence, success и rollback/stop conditions записаны в
[`docs/EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md`](EXPERIMENTAL_RELEASE_OPERATIONS_CHECKLIST.md). Это план будущих owner-approved действий; ни одно из них в ходе аудита не выполнялось.

## Двухосевой review

Review выполнен относительно `661a98974aac7bbc69dc321a876eacee65ec9819` двумя независимыми проверками.
Standards нашёл три замечания: исполняемый через `sudo` rollback из изменяемого release-каталога,
production credentials в recovery rehearsal и отсутствующий post-build Chromium E2E. Spec нашёл два:
тот же post-build пробел и три неотмеченных P0 в исходном ТЗ. Все замечания устранены: rollback ссылается
на отдельно проверенную root-owned копию, recovery требует только изолированные rehearsal credentials,
`dist/public` прошёл повторный Chromium E2E, а доказанные P0 отмечены в фактическом внешнем ТЗ.

После исправлений повторены релевантные проверки: `npm.cmd run lint` и `npm.cmd run check` завершились с
exit 0; `npm.cmd test` дал 425 total, 424 pass, 0 fail, 1 protective PostgreSQL skip; working-tree secret scan
проверил 295 tracked files, history scan — 236 commits, совпадений нет. Обе readiness-команды снова дали
strict 439/477 = 92.0% и experimental 440/448 = 98.2%. `git diff --check` не сообщил ошибок.
