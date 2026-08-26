# Aisy — production UI на основе «A — Бумажный маршрут»

Status: approved for implementation
Owner: product owner
Mode: `/autopilot semi`
Approved visual source: `.scratch/aisy-style-lab/owner-decision.md`

## Problem Statement

У Aisy уже утверждены узнаваемая мобильная цепочка первого запуска и направление
**A — «Бумажный маршрут»**, но production-приложение визуально и поведенчески остаётся набором нескольких
поколений интерфейса. Login, onboarding, пять разделов оболочки и глубокие учебные экраны используют разные
цвета, кнопки, тени, типографику и способы навигации; значительная часть presentation-правил находится в
inline-стилях. На широком экране PWA превращает нижнюю навигацию в боковую панель, хотя продукт утверждён как
один портретный телефон. Текущий Telegram-вход не соответствует принятому направлению VK ID, onboarding
стоит после регистрации и фактически обходится, а профиль обещает Free-доступ, которого строгий access gate
не предоставляет.

Нельзя просто заменить палитру: нужно перенести единую систему на весь реальный learner-контур, не сломав
router, серверную сессию, хранение прогресса, adaptive/EGE engines, офлайн-состояния и активную подписку.
Отдельная сложность — VK ID: приложение VK пока не создано, поэтому интеграция должна быть реализована и
проверяема локально, но production-активация обязана оставаться честно заблокированной до появления
настоящего APP_ID и разрешённого redirect URL.

## Solution

Перестроить production learner UI как одну mobile-first PWA на основе утверждённого направления A. Общий
трёхслойный набор токенов (primitive → semantic → component) задаёт тёплую бумагу, сливовые чернила,
AA-safe коралловое действие, физичную глубину вниз-вправо, типографику Nunito + Manrope и согласованные light/
dark темы. Все пять верхних разделов и все активные глубокие учебные экраны получают общие поверхности,
кнопки, choices, статусы, bottom navigation и deep action dock. На любой ширине learner-интерфейс остаётся
центрованным портретным телефоном без desktop side rail.

Канонический стартовый путь:

`Логотип → onboarding → вход через VK ID → проверка подписки → Сегодня`.

Onboarding показывается один раз на устройстве до входа и может быть повторно запущен из профиля. VK ID
реализуется как provider adapter: сервер создаёт одноразовые state/PKCE данные, обрабатывает callback, связывает
provider subject с внутренним учеником и только после этого выдаёт существующую HttpOnly cookie-сессию.
OAuth-токены не попадают в localStorage и не становятся клиентским контрактом. Для разработки создаётся
явно включаемый local fake provider, запрещённый в production. Если VK ID не сконфигурирован, экран входа
показывает понятное недоступное состояние, а не фиктивный успех.

## User Stories

1. Как новый ученик, я хочу сначала увидеть короткую страницу с логотипом, чтобы понять, какое приложение открылось.
2. Как новый ученик, я хочу пройти компактный onboarding до входа, чтобы заранее понять пользу и ритм Aisy.
3. Как вернувшийся ученик, я хочу пропускать уже завершённый onboarding, чтобы сразу перейти к проверке сессии.
4. Как ученик, я хочу повторно открыть onboarding из профиля, чтобы вспомнить возможности приложения.
5. Как ученик, я хочу входить одной понятной кнопкой VK ID, чтобы не выбирать между конкурирующими способами входа.
6. Как ученик, я хочу вернуться в приложение после VK ID без ручного копирования кода, чтобы вход ощущался непрерывным.
7. Как ученик, я хочу получить ясное сообщение при отмене, истёкшем state, сетевой ошибке или неверной конфигурации VK, чтобы понимать следующий шаг.
8. Как ученик, я не хочу видеть учебные данные до подтверждения серверной сессии и активной подписки, чтобы доступ был честным и безопасным.
9. Как ученик без активной подписки, я хочу увидеть спокойный экран «Нужен активный доступ» с понятным дальнейшим действием, а не обещание несуществующего Free-плана.
10. Как ученик с временно недоступной сетью, я хочу отличать неизвестный статус подписки от неактивной подписки, чтобы не потерять доверие к продукту.
11. Как ученик, я хочу видеть Aisy как один портретный интерфейс на телефоне, планшете и в desktop-браузере, чтобы навигация не меняла модель между устройствами.
12. Как ученик, я хочу всегда находить пять разделов в порядке Сегодня / Практика / ЕГЭ / Прогресс / Профиль, чтобы сформировать устойчивую привычку.
13. Как ученик в глубоком задании, я хочу видеть назад и одно главное действие в нижнем dock, чтобы не конкурировать с глобальной навигацией.
14. Как ученик, я хочу на Сегодня сразу видеть рекомендацию, длительность, причину и одно действие start/continue, чтобы не искать следующий шаг.
15. Как ученик, я хочу сохранить реальные production-длительности и адаптивный план, чтобы редизайн не менял учебную механику.
16. Как ученик, я хочу в Практике быстро выбирать слова, грамматику, аудирование, чтение, письмо и говорение, чтобы модули оставались узнаваемыми.
17. Как ученик, я хочу в ЕГЭ видеть спокойный вход в разделы и полный пробник, чтобы экзаменационный режим не выглядел игровым дашбордом.
18. Как ученик, я хочу в Прогрессе сначала видеть изменение, слабое место и следующий шаг, чтобы метрики помогали действовать.
19. Как ученик, я хочу в Профиле видеть личные настройки, статус доступа, privacy/export/delete/logout и тему в одной иерархии, чтобы управлять аккаунтом без скрытых действий.
20. Как ученик, я хочу, чтобы слова и грамматика использовали одинаковые карточки, choices и обратную связь, чтобы управление не приходилось переучивать.
21. Как ученик, я хочу, чтобы чтение и аудирование имели спокойный рабочий лист, видимый прогресс задания и доступные media controls, чтобы декор не мешал концентрации.
22. Как ученик, я хочу, чтобы письмо и говорение показывали этап, ограничение, сохранение и отправку единообразно, чтобы длинные задания были предсказуемыми.
23. Как ученик, я хочу отличать ожидание AI-разбора, готовый результат, recoverable error и лимит, чтобы всегда понимать состояние работы.
24. Как ученик полного пробника, я хочу строгую, устойчивую оболочку таймера и навигации, чтобы визуальное обновление не меняло экзаменационный контракт.
25. Как ученик, я хочу видеть Asya как контекстную помощницу, а не шестую вкладку, чтобы основная информационная архитектура оставалась ясной.
26. Как ученик, я хочу одну форму primary CTA по всему приложению, чтобы коралловая кнопка всегда означала движение вперёд.
27. Как ученик, я хочу светлые secondary/choice controls с ощутимой бумажной глубиной, чтобы они выглядели нажимаемыми без generic outline-полей.
28. Как ученик, я хочу selected, correct, incorrect, loading, disabled, offline и error состояния с текстом/иконкой, чтобы смысл не зависел только от цвета.
29. Как ученик, я хочу, чтобы системная тёмная тема автоматически превращалась в тёплую тёмную бумагу, а не в инверсию, чтобы приложение оставалось фирменным вечером.
30. Как ученик, я хочу вручную выбрать светлую, тёмную или системную тему в профиле, чтобы приложение учитывало мои условия.
31. Как пользователь клавиатуры, я хочу логичный focus order и заметное plum-кольцо, чтобы пройти весь основной контур без мыши.
32. Как пользователь screen reader, я хочу семантические headings, buttons, radios, status/live regions и accessible names, чтобы интерфейс сообщал структуру и изменения.
33. Как пользователь сенсорного экрана, я хочу цели не меньше 44×44 px и safe-area отступы, чтобы элементы не перекрывались вырезом или home indicator.
34. Как пользователь с motion sensitivity, я хочу reduced-motion режим без пространственного сдвига бумажных слоёв, чтобы информация сохранялась без дискомфорта.
35. Как пользователь маленького телефона 320–360 px, я хочу отсутствие горизонтального скролла и доступное главное действие, чтобы экран не был витринным макетом.
36. Как пользователь в landscape, я хочу получить тот же телефонный контур с прокруткой и нижней навигацией, а не боковую панель.
37. Как пользователь установленной PWA, я хочу корректный splash/app-shell и честные offline-состояния, чтобы обновлённый UI работал после установки.
38. Как разработчик, я хочу менять palette/spacing/motion через semantic tokens, чтобы следующий визуальный апдейт не требовал переписывать каждый экран.
39. Как разработчик, я хочу, чтобы production components потребляли component tokens и общие state-классы, чтобы inline presentation не расходился повторно.
40. Как разработчик, я хочу сохранить существующие screen IDs, router hooks, API/store contracts и учебные engines, чтобы редизайн оставался presentation/auth migration.
41. Как разработчик, я хочу один контракт identity provider для VK и local fake, чтобы тесты не зависели от внешнего OAuth и секретов.
42. Как оператор, я хочу, чтобы production отказывался стартовать/включать VK-вход при неполной конфигурации, чтобы не показывать нерабочую авторизацию.
43. Как оператор, я хочу документированный список callback URL и имён env-переменных без значений секретов, чтобы безопасно завершить настройку в кабинете VK ID.
44. Как специалист по безопасности, я хочу одноразовые state/PKCE записи с TTL, exact redirect URI, rate limiting и server-side token exchange, чтобы снизить риск CSRF, replay и утечки токенов.
45. Как специалист по privacy, я хочу хранить только необходимый provider subject и минимальный профиль, чтобы VK ID не расширял сбор данных без нужды.
46. Как QA, я хочу воспроизводимый local fake flow, чтобы проверить logo → onboarding → login → access → Today без настоящего аккаунта VK.
47. Как QA, я хочу автоматические проверки light/dark, reduced motion, 320/375/768/1440, portrait/landscape и offline, чтобы утверждённый phone-контракт не регрессировал.
48. Как QA, я хочу проверить каждый активный глубокий экран хотя бы в ready и одном неблагополучном состоянии, чтобы редизайн не заканчивался на Today.
49. Как владелец продукта, я хочу, чтобы production визуально продолжал уже утверждённый onboarding и A, чтобы работа не открывала новый круг выбора стилистики.
50. Как владелец продукта, я хочу получить собранный `dist/public`, кликабельный локальный результат и release evidence, чтобы можно было принять реализацию целиком.

## Implementation Decisions

- Production остаётся на существующих native ES modules + Vite. React/Tailwind/shadcn не добавляются: ADR 0001
  сохраняется, а принципы токенов и доступных компонентов реализуются в текущем стеке.
- Существующие router IDs, lazy screen registry, API, storage, adaptive learning, EGE и assessment contracts не
  меняются без отдельной необходимости. Презентационные inline-стили мигрируют поэкранно в общие классы.
- Learner canvas имеет ширину `min(100vw, 390px)` и центрируется на более широком stage. Bottom navigation
  остаётся снизу на всех viewport; desktop side rail удаляется как намеренное изменение product contract.
- Каноническая последовательность состояния: splash → onboarding при отсутствии локального completion marker →
  login при отсутствии серверной сессии → access check → subscription-required/network-unknown/Today.
- Completion onboarding хранится локально как versioned preference и не является доказательством identity.
  Logout не сбрасывает его; профиль предлагает явное повторное прохождение.
- Токены разделяются на primitive, semantic и component layers. Light и dark меняют semantic aliases; компоненты
  не содержат собственных literal palette values, кроме документированных иллюстративных деталей.
- Основная типографика: локальный Nunito для display/чисел и Manrope для интерфейса/текста. Acrom не используется,
  пока в репозитории нет подтверждённой production-лицензии.
- Primary CTA: 58 px высота, 28 px radius, full width, около 26/10 px внутреннего поля, 38×38 cream affordance
  справа, label слева, down-right depth. Default coral — `#B9433A` с warm-white текстом (около 5.26:1), hover —
  `#9F342F`; светлые coral остаются декоративными.
- В composed screen допускаются canvas → hero/sheet → nested control, один solid coral CTA и не более двух
  дополнительных chromatic accents above the fold. Today не превращается в bento/dashboard.
- Motion: press 160–220 ms, local feedback около 220 ms, screen transition 320–520 ms. Направление A использует
  один сдвиг бумажного слоя; reduced motion заменяет пространственное движение короткой opacity-сменой.
- Тёмная тема — тёплая dark-paper mapping с отдельными surface/text/status/focus aliases. Начальное значение
  следует `prefers-color-scheme`; профиль хранит `system | light | dark` и обновляет `color-scheme`.
- VK ID — единственная ученическая action на production-login. Парольный/admin/staging контур остаётся серверно
  отдельным и не появляется в learner UI. Telegram learner-login выводится из production UI без удаления
  административных/исторических данных до отдельной очистки.
- VK adapter реализует Authorization Code с PKCE по актуальному официальному VK ID OAuth 2.1 контракту. Сервер
  создаёт `state`, `code_verifier`, TTL и одноразовую запись, принимает callback, обменивает code, получает
  минимальный user identity, связывает `(provider, subject)` с внутренним username и выдаёт существующую
  HttpOnly/SameSite cookie-сессию. Браузер не получает provider access/refresh token как storage contract.
- Идентичности хранятся provider-agnostic; Telegram association и отдельные admin credentials не смешиваются с
  VK subject. Миграция обратима на уровне данных и не меняет ownership существующего прогресса.
- Конфигурация использует только имена переменных в документации: `VK_ID_APP_ID`, `VK_ID_REDIRECT_URI` и, если
  выбранный тип приложения VK требует confidential exchange, `VK_ID_CLIENT_SECRET`. Значения секретов никогда
  не записываются в репозиторий, логи, скриншоты или клиентский bundle.
- `PLACEHOLDER — владелец должен создать VK ID application, зарегистрировать точный callback URL и передать
  значения через secret storage окружения`. До этого production UI показывает «VK ID пока не подключён».
- Local fake identity разрешается только явным dev/test flag, запрещается при `NODE_ENV=production`, не вызывает
  внешнюю сеть и проходит тот же внутренний identity/session/access path после provider boundary.
- Проверенная официальная опора на 2026-08-26: VK ID Web SDK 2.6.1 заявляет OAuth 2.1, APP_ID,
  `redirectUrl`, `state`, `codeVerifier` и code exchange. Перед live-активацией endpoint/domain следует повторно
  сверить с официальной документацией VK ID, включая актуальный домен `id.vk.ru`.
- Strict active-subscription-only shell сохраняется. Все обещания Free/demo в learner UI удаляются; отсутствие
  платежного provider не подменяется фиктивной покупкой. Реальная активация доступа остаётся внешним операторским
  процессом до отдельного payment ticket.
- Service worker кэширует только production app-shell assets нужной версии. Auth callbacks, `/me`, subscription
  и другие персональные API не кэшируются; offline copy не обещает действия, которым нужен сервер.

## Testing Decisions

- Главный seam — реальный production build и пользовательский контур через существующие Aisy Playwright tests:
  первый запуск, восстановление сессии, strict access, пять destinations и несколько глубоких задач.
- Auth seam — provider contract tests и local fake end-to-end. Проверяются одноразовый state, TTL, PKCE,
  повтор callback, отмена, provider error, неполная конфигурация, production ban fake-provider, связывание
  identity и выдача/revocation существующей cookie-сессии. Live VK сеть в CI не вызывается.
- Visual/component seam — semantic tokens, кнопочная анатомия, state classes, light/dark screenshots и отсутствие
  raw production colors в migrated component rules. Проверяются реальные пиксели, а не только наличие CSS.
- Responsive matrix: Chromium 320/375/768/1440, portrait и landscape. На каждом размере canvas ограничен,
  horizontal overflow равен нулю, touch targets ≥44 px, bottom navigation не превращается в rail.
- Accessibility: WCAG AA для normal text, 3:1 для large/non-text/focus, visible focus, keyboard traversal,
  semantic labels/groups/live regions, non-color state cues и dialog focus management.
- Motion: обычный режим проверяет один paper transition и press feedback; `prefers-reduced-motion: reduce`
  исключает пространственный transform/route drawing и сохраняет видимое состояние.
- Theme: `system`, forced `light` и forced `dark` проверяются до первого paint и после reload, включая splash,
  onboarding, login, access gate, top-level/deep screens, alerts и bottom chrome.
- Deep-screen smoke matrix охватывает Words, Grammar, Listening, Reading, Writing, Speaking, AI waiting/review и
  full EGE mock без изменения их domain answers/timers/persistence.
- PWA/offline: manifest/icons/splash, service-worker version update, cached shell load, uncached action truth,
  no-store auth/access endpoints и корректный upgrade из предыдущего cache version.
- Release gate: `npm run lint`, `npm run check`, `npm test`, production frontend build, Aisy E2E, adaptive/EGE
  relevant E2E, performance budget и secret scans. `dist/public` пересобирается после финального source-check.

## Out of Scope

- Admin UI, operator console, teacher/parent products и редизайн staging-инструментов.
- Изменение learning logic, scoring, content banks, adaptive rules, production duration ranges или EGE format.
- Выбор/подключение платёжного провайдера, checkout, auto-renewal и публичный Free/demo режим.
- Live создание приложения в кабинете VK ID, передача реальных секретов и production deployment.
- React migration, новая design framework, Tailwind/shadcn installation или полный URL-router rewrite.
- Новое направление B/C, смешанный четвёртый концепт, literal copy чужих reference assets или новый mascot.
- Использование Acrom до подтверждения лицензии; покупка шрифтов или сторонних иллюстраций.
- Удаление исторических Telegram identity данных и экстренного admin/staging login до отдельного migration plan.
- Изменение API/DB contracts, не необходимое для provider-agnostic identity linkage и безопасного VK callback.

## Further Notes

- Source of truth для визуального решения: `.scratch/aisy-style-lab/final-handoff.md`,
  `.scratch/aisy-style-lab/design-system.md` и `.scratch/aisy-style-lab/bar.md`. Выбран только A; механики B/C
  не переносятся без нового явного решения.
- Официальные технические источники VK ID для implementation review:
  `https://vkcom.github.io/vkid-web-sdk/docs/index.html` и
  `https://github.com/VKCOM/vkid-web-sdk`. Они подтверждают SDK/OAuth 2.1/PKCE форму, но не заменяют регистрацию
  приложения и повторную проверку кабинета владельцем перед production-активацией.
- Existing `dist/public` может быть старее source, а сервер предпочитает dist при наличии. Финальный результат
  считается готовым только после явной пересборки и проверки именно собранной версии.
- Прототипы остаются approval evidence и не становятся runtime dependency production UI.
