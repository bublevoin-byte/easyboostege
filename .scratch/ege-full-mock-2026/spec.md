# Полный пробный ЕГЭ по английскому языку — 2026

Status: approved-for-implementation
Owner decisions recorded: 2026-08-13

## Зачем это нужно

На главной Easy Boost уже обещан «Пробный ЕГЭ», а отдельные модули умеют воспроизводить части экзамена. Пользователю нужен один связный, строгий и возобновляемый пробник: от старта письменной части до результата устной, с честным разделением точных и предварительных баллов.

## Решения владельца

- Реализуется полная, а не сокращённая версия.
- Основа первой версии — утверждённая структура ФИПИ ЕГЭ-2026; каталоги и попытки версионируются для будущих лет.
- Одна попытка объединяет письменную и устную части, но между ними разрешена пауза.
- Внутри каждой части действует строгий таймер с автоматической сдачей; перезагрузка или потеря сети таймер не останавливает.
- В экзаменационный балл попадает только заранее проверенный авторский контент. ИИ не генерирует задания пробника.
- Задания с развёрнутым ответом оцениваются автоматически только как предварительные; интерфейс и API не называют такую оценку экспертной или официальной.
- Первый релиз содержит один эталонный вариант.
- Первый завершённый проход считается диагностическим. Повторы после раскрытия ответов помечаются как тренировочные и не меняют исходный прогноз.
- Полный разбор и ключи открываются только после завершения обеих частей.
- Существенное расширение банка обязательно после первого релиза и вынесено в отложенный Ticket 99.

## Нормативная матрица

Источник фактов — утверждённые ФИПИ демоверсия, спецификация и кодификатор ЕГЭ-2026 по английскому языку, проверенные 2026-08-13:

- https://fipi.ru/ege/demoversii-specifikacii-kodifikatory
- https://doc.fipi.ru/ege/demoversii-specifikacii-kodifikatory/2026/aya_11_2026.zip

Материалы ФИПИ используются для сверки структуры, времени и критериев. Их задания, тексты, изображения и аудио не копируются в банк Easy Boost.

| Раздел | Позиции | Максимум первичных баллов | Время |
|---|---:|---:|---:|
| Аудирование | 1–9 | 12 | ориентир 30 минут внутри письменной части |
| Чтение | 10–18 | 12 | ориентир 30 минут внутри письменной части |
| Грамматика и лексика | 19–36 | 18 | ориентир 40 минут внутри письменной части |
| Письменная речь | 37–38 | 20 (6 + 14) | ориентир 90 минут внутри письменной части |
| Говорение | 39–42 (устные 1–4) | 20 (1 + 4 + 5 + 10) | 17 минут |
| Всего | 42 задания | 82 | 190 + 17 = 207 минут |

Письменные ориентиры не создают отдельных автосдач: authority — общий письменный deadline в 190 минут. Устная часть получает отдельный deadline в 17 минут после явного старта.

## Пользовательский сценарий

1. Авторизованный пользователь открывает карточку «Полный пробный ЕГЭ».
2. Приложение показывает состав, правила, продолжительность, статус подписки и техническую готовность.
3. До запуска письменного таймера приложение полностью загружает и проверяет immutable form manifest и все аудио варианта. Новый пробник нельзя начать офлайн.
4. Сервер создаёт owner-bound попытку, фиксирует `formId`, `formRevision`, `examYear`, diagnostic/training mode, server start/deadline и initial revision.
5. Пользователь проходит письменные разделы в официальном порядке. Он может переходить между разделами, менять ответы и видеть незаполненные позиции, но не ключи, баллы или подсказки.
6. Ответы автоматически сохраняются локально и синхронизируются с сервером. Reload восстанавливает exact attempt. Offline completion попадает в bounded durable queue и использует тот же UUID/idempotency material.
7. По истечении 190 минут письменная часть сдаётся автоматически; пропуски остаются пустыми. Досрочная сдача требует подтверждения.
8. После письменной части пользователь может покинуть приложение и позднее начать устную. По умолчанию незапущенная устная часть доступна 30 дней; срок хранится в versioned policy и показывается заранее.
9. Перед устной частью выполняются проверка микрофона и готовность immutable speaking assets. Только затем сервер запускает отдельные 17 минут.
10. Устные задания следуют фиксированным preparation/recording stage deadlines. Перезаписать завершённый ответ нельзя.
11. После завершения обеих частей открывается результат. Задания с ключом рассчитываются точно; задания 37–38 и устные 3–4 получают явно маркированную предварительную оценку. Пока оценка провайдера не готова, результат остаётся в состоянии `assessment_pending`, не теряя точные баллы.
12. Пользователь видит первичные баллы по разделам, точную/предварительную природу каждого компонента, прогноз 100-балльного результата, ошибки и рекомендуемые тренировки.
13. После раскрытия ключей новый проход того же `formId@revision` создаётся только в `training` mode и не заменяет диагностический прогноз.

## Авторский вариант

Первый catalog release имеет стабильную identity вида `ege-en-2026-form-1@1` и fingerprint содержимого. Manifest содержит только проверенные ссылки на immutable content entries и assets:

- один полный authored listening set для позиций 1–9;
- один полный authored reading set для позиций 10–18;
- 18 authored grammar/lexis gaps для позиций 19–36; существующий Grammar exam 19–24 подключается по immutable reference, позиции 25–36 дополняются авторским банком;
- по одному authored assignment для 37 и 38 с versioned criteria reference;
- один authored speaking set для заданий 1–4 устной части;
- точные answer keys, допустимые finite variants, per-position score rules, content taxonomy и asset digests.

Manifest, который не даёт ровно 42 позиции, 82 максимальных первичных балла, требуемое распределение или полный набор assets, не публикуется и не запускается. Answer key никогда не входит в публичную start/draft projection.

## Модель попытки и authority

- Identity: `attemptId`, `ownerGeneration`, `formId`, `formRevision`, `catalogFingerprint`, `mode`, `attemptNumber`.
- States: `created`, `written_in_progress`, `written_submitted`, `oral_ready`, `oral_in_progress`, `assessment_pending`, `completed`, `expired`.
- Сервер владеет start/deadline/state/revision, form membership, objective scoring, mode и final result.
- Клиент владеет только редактируемым draft до сдачи. Каждый save использует owner binding и compare-and-set revision; stale draft не может перезаписать более новый.
- Start, draft save, written submit, oral start, oral completion и assessment retry идемпотентны.
- Server receipt связывает part completion с owner, exact attempt/form/revision, ordered item IDs, deadline и payload digest. Новый UUID не позволяет переиспользовать старый receipt.
- Offline queue очищается только после server apply/replay exact event; queued не считается durable result.
- Одновременно у пользователя может быть только одна незавершённая диагностическая попытка этой формы. Тренировочная попытка не скрывает и не переписывает её.

## Оценивание

### Точные компоненты

Сервер повторно вычисляет ответы 1–36 из immutable answer key; клиентские score/error claims не являются authority. Нормализация и допустимые варианты принадлежат одному versioned assessment module и одинаково используются score, result UI, error focus и Voice Tutor.

### Развёрнутые ответы

- Задания 37 и 38 проходят существующую серверную deterministic preflight и versioned AI rubric evaluation.
- Устные 1–4 используют существующие exact stage recordings; официальный task 1 может иметь детерминированные/акустические компоненты, но итоговая автоматическая оценка всё равно отображается как предварительная, если не подтверждена экспертным контуром.
- Задания 3–4 устной части всегда маркируются `experimental` / `approximate` в API и UI до прохождения строгого качества §11 основного ТЗ.
- Ошибка или недоступность провайдера не теряет попытку: exact objective score сохраняется, subjective assessment остаётся retryable и не создаёт повторную платную оценку при replay.
- Полный текст и аудио ученика не попадают в логи, метрики, error focus или публичную OpenAPI example projection.

### Итог

- Результат хранит `objectivePrimary`, `provisionalSubjectivePrimary`, `primaryTotal`, max 82 и breakdown по пяти разделам.
- Прогноз 100-балльного результата использует отдельную versioned conversion table/policy и всегда называется прогнозом, а не официальным баллом.
- При pending/failed subjective assessment показывается диапазон или неполный provisional total, а не выдуманный ноль.
- Ошибки пробника могут создавать диагностические рекомендации и error focus, но не засчитываются как самостоятельное освоение учебной темы.

## API и хранение

Продуктовые маршруты живут под `/api/v1/ege-mocks` и документируются executable OpenAPI:

- `GET /forms` — answer-free доступные authored forms;
- `POST /attempts` — start/replay owner-bound attempt;
- `GET /attempts/current` и `GET /attempts/{attemptId}` — safe restore projection;
- `PUT /attempts/{attemptId}/draft` — CAS draft save;
- `POST /attempts/{attemptId}/written/submit`;
- `POST /attempts/{attemptId}/oral/start`;
- `POST /attempts/{attemptId}/oral/submit`;
- `POST /attempts/{attemptId}/assessment/retry` — только когда retry разрешён server state;
- `GET /attempts/{attemptId}/result` — без ключей до завершения обеих частей.

File repository и PostgreSQL реализуют один shared contract: lifecycle, timer authority, idempotent replay/conflict, draft CAS, owner isolation, score/result, export, account deletion, retention и concurrent submit. Новая миграция не изменяет старые Grammar 2.0, Writing или Speaking records задним числом.

## PWA, доступность и безопасность

- Старт требует сети; продолжение exact already-started part допускает офлайн после asset preflight.
- Service worker кеширует manifest и необходимые assets по revision/digest, не кладёт answer keys или пользовательские ответы в общий cache.
- Reload, закрытие вкладки, offline/online и cross-tab не создают второй таймер, второй submit, вторую AI reservation или второй результат.
- Управление доступно с клавиатуры; controls не меньше 44 px; screen reader получает section, task, timer warnings и save status; reduced motion поддерживается; на 320 px нет horizontal overflow.
- Таймер предупреждает на 30/10/5/1 минутах без навязчивого фокуса. `prefers-reduced-motion` отключает пульсацию.
- Требуется активная подписка на start и server mutations. Уже начатая часть не раскрывается другому owner/incarnation после logout/login.
- Logs/metrics содержат только bounded IDs, durations, state transitions, counts и error codes.

## Результат и повтор

После обеих частей result screen показывает:

- «Диагностический» или «Тренировочный повтор»;
- breakdown 12/12/18/20/20 и общий 82;
- точные и предварительные компоненты разными подписями;
- прогноз тестового балла с версией шкалы и предупреждением;
- список заданий, ответ, правильный ответ/критерии и безопасный разбор;
- ссылки на существующие listening/reading/grammar/lexis/writing/speaking тренировки;
- состояние evaluation pending/retry без потери уже рассчитанного результата.

Первый diagnostic result закрепляется как baseline. Training repeat сохраняется в истории, но не подменяет baseline и не используется как новый независимый прогноз.

## Не входит

- Копирование заданий, аудио или изображений ФИПИ.
- Несколько полноценных вариантов в первом релизе.
- Генерация экзаменационного контента ИИ.
- Гарантия официальной или экспертной оценки развёрнутых ответов.
- Панель преподавателя, ручная экспертная проверка и прокторинг.
- Push, staging/production deploy или реальные платные provider-прогоны агентом.

## Acceptance gates

- Catalog property tests доказывают exact 42 positions, 82 points, section matrix, immutable refs, asset digests и отсутствие answer leakage.
- Public TDD покрывает timer authority, reload/offline, CAS, idempotency, auto-submit, blanks, replay/conflict, diagnostic/training split и keys-after-both-parts.
- Objective score, writing/speaking provisional state и total никогда не расходятся между runtime, UI, persistence и executable OpenAPI.
- File и live PostgreSQL shared contract зелёные после миграций с полным cleanup disposable resources.
- Desktop/mobile Chromium E2E проходит полный вариант, offline reload/queue/reconnect, timer expiry, keyboard, reduced motion, 44 px и no overflow.
- `npm test`, `npm run lint`, `npm run check`, generated OpenAPI check, frontend build, security/history/diff scans и свежий authorized production audit зелёные.
- Каждый тикет проходит свежий Standards + Spec review на одной замороженной identity и закрывается одним локальным коммитом; push/deploy не выполняются.

## План после релиза

Ticket 99 остаётся `needs-triage`: существенно расширить проверенный авторский банк, добавить несколько равноценных immutable forms, методическую двойную проверку, anti-repeat policy и calibration по формам. Этот пункт обязателен к напоминанию владельцу при завершении текущей серии.
