# Design-loop progress — Aisy Style Lab

| Часть | Круг | Критик ТЗ | Критик системы | Критик ремесла | Состояние |
|---|---:|---|---|---|---|
| Foundation / shell | 22 | ПРОЙДЕНО | ПРОЙДЕНО | ПРОЙДЕНО | завершено |
| A — бумажный маршрут | 7 | ПРОЙДЕНО | ПРОЙДЕНО | ПРОЙДЕНО | завершено |
| B — тактильные виджеты | 4 | ПРОЙДЕНО | ПРОЙДЕНО | ПРОЙДЕНО | завершено |
| C — сюжетный маршрут | 2 | ПРОЙДЕНО | ПРОЙДЕНО | ПРОЙДЕНО | завершено |
| Финальное сравнение | 3 | ПРОЙДЕНО | ПРОЙДЕНО | ПРОЙДЕНО | готово к выбору владельца |
| Кнопочная система A/B | 3 | ПРОЙДЕНО | ПРОЙДЕНО | ПРОЙДЕНО | готово к выбору владельца |

### Кнопочная система A/B · круг 1

- Primary/deep CTA получили утверждённую onboarding-анатомию `58 / 28 / 26 / 10 / 38`, coral gradient, левый
  label и отдельный кремовый affordance; secondary/choices переведены на raised paper keys.
- Все три критика отклонили актуальный кадр: B choices всё ещё читались как outline-поля, а disabled CTA терял
  светлый круг.

### Кнопочная система A/B · круг 2

- B default choices получили мягкую кромку, gradient и raised shadow; selected — sunken seat. Disabled сохраняет
  общий силуэт, отдельный светлый круг и приглушённый chevron.
- Критики ТЗ и ремесла: `ПРОЙДЕНО`. Критик системы: `НЕ ПРОЙДЕНО` — B selected оставался плоским из-за
  доминирующего фиолетового outline.

### Кнопочная система A/B · круг 3

- У B selected outline заменён общей мягкой кромкой default key, внутренний sunken shadow усилен, marker
  сохраняет однозначный выбор.
- Точные round-3 рендеры: A/B Components `390×844` и A/B Task `360×720`.
- Актуальная matrix: `24/24`, failures `0`; selected regression `2/2`; static QA, focused lint, check и diff-check
  зелёные. Production UI/API/storage/service worker не затронуты.
- Три полностью свежих критика: `ПРОЙДЕНО / ПРОЙДЕНО / ПРОЙДЕНО`.

### Финальное сравнение · круг 1

- Reviewer-only экран `Решение` остаётся внутри того же портретного телефона.
- URL хранит ровно одну основу и максимум два нормализованных заимствования; same-base, unknown, duplicate и
  третий borrowing отбрасываются.
- Production UI, API, storage и service worker не затрагиваются.
- Критик ремесла: `ПРОЙДЕНО`.
- Критик системы: `ПРОВАЛ` — invalid `base` очищался до пустого, но мог оставить два валидных borrowings.
- Критик ТЗ: `ПРОВАЛ` — исходный login раскрывал статус VK-placeholder только после клика, а не до него.
- Исправление decision: пустая/unknown основа теперь fail-closed очищает весь borrowing-массив.
- Исправление opening: добавлена reviewer-only обёртка с постоянным видимым сообщением «VK — placeholder;
  backend авторизации ещё не подключён», не меняющая существующий onboarding прототип.

### Финальное сравнение · круг 2

- Invalid-base live URL нормализуется в `base=''`, `borrow=[]`, `0 из 2`; все шесть borrowing controls disabled.
- Opening wrapper сохраняет телефонный splash/onboarding/login в iframe и держит честный VK/backend статус
  снаружи телефона на всём пути.
- Три свежих критика получают exact round-2 URLs после зелёных static/lint/check/diff gates.
- Критик ремесла: `ПРОЙДЕНО`.
- Критик ТЗ: `ПРОВАЛ` — переход непосредственно к шагу входа прокручивал внешнюю оболочку на 82px, поэтому
  reviewer note уходил выше viewport до взаимодействия с VK-кнопкой.
- Критик системы был остановлен после подтверждённого провала круга: результат уже требовал новой общей петли.
- Исправление: reviewer note переведён в `position: sticky` с верхним резервом 8px. Live-проверка после перехода
  на «Шаг 4 — вход» подтверждает `scrollY=66`, note `top=8…bottom=78`, login видим и disclosure остаётся в viewport.

### Финальное сравнение · круг 3

- Три свежих критика получают только актуальные live URLs и round-3 blocker proof.
- Static QA теперь отдельно требует sticky disclosure; lint/check/unit/diff остаются зелёными.
- Критик ТЗ: `ПРОЙДЕНО` — step-4 disclosure полностью виден при `scrollY=66`, CTA и production isolation
  подтверждены.
- Критик системы: `ПРОЙДЕНО` — phone остаётся `390×844`, общий fixture/nav, fail-closed worksheet, focus,
  touch-target и compact containment сохранены.
- Критик ремесла: `ПРОЙДЕНО` — sticky note остаётся отдельным reviewer layer и не разрушает композицию
  onboarding, A/B/C, worksheet или 26 портретных рендеров.
- Финальное сравнение готово к человеческому решению: одна основа A/B/C и максимум два заимствования.

### C — сюжетный маршрут · круг 1

- Добавлен отдельный `renderers/c.js`, который проецирует общий foundation fixture и добавляет только абсолютный
  illustrated route layer; production UI не затронут.
- Четыре stage-landmark используют разные учебные символы: стартовый флаг, практика, открытие правила и orange
  goal-rosette с коротким dotted continuation на завтра. SVG декоративный, `aria-hidden`, `focusable=false`.
- Direct `360×720` и canonical phone `390×844` проверены `8/8`: overflow/side rail нет, artwork не влияет на flow,
  controls `≥44px`, labels `≥12px`, body/CTA `≥15px`, edge focus помещается внутри phone.
- Forward-only route draw показывает только следующий участок (`1→.67→.33→0`) за `480ms`, incoming content
  поднимается на `8px/420ms`; один screen/CTA, clone отсутствует. Back/skip/local changes остаются static.
- Reduced-motion CSS сразу показывает итоговый route, удаляет translate/draw и оставляет opacity-only settlement.
- Три свежих независимых live-browser критика получают exact round-1 matrix на замороженной версии.

- Критики ТЗ и ремесла: `ПРОЙДЕНО`.
- Критик системы: `ПРОВАЛ` — на Today нижний край текущего landmark оставлял только 3px до окрашенной области
  заголовка и визуально читался как коллизия.
- Исправление: заголовок Today опущен на 8px и теперь имеет 11px direct / 15px canonical просвет до landmark.
  Заодно shared decorative SVG получили `focusable=false`, а пример правила поднят с 12px до body-роли 15px.

### C — сюжетный маршрут · круг 2

- Direct `360×720`: Today landmark заканчивается на `y=175`, title начинается на `y=186`; surface/proof
  заканчиваются на `556.8/608.8`, nav начинается на `644`. Review surface заканчивается на `611.3`, dock — с
  `646`; горизонтального или вертикального overflow нет.
- Canonical `390×844`: landmark заканчивается на `y=208`, Today title начинается на `y=223`; Today
  surface/proof заканчиваются на `680.1/760.1`, nav начинается на `787`. Review surface заканчивается на
  `692.9`, dock — с `789`.
- Static QA, lint и syntax/inline-handler check прошли; три свежих критика получают exact round-2 matrix.
- Критики ТЗ, системы и ремесла: `ПРОЙДЕНО`. Они независимо подтвердили direct/canonical containment,
  `11/15px` landmark-title clearance, один CTA, пять нижних разделов/deep dock, route/static/reduced motion и
  сохранение общего fixture.

## История дыр и исправлений

### Foundation / shell · круг 1

- Общая дыра трёх критиков: первый PNG был зафиксирован в `opacity: .25` и выглядел как глобальное
  disabled-состояние; основной текст, CTA и иерархия теряли контраст.
- Исправление: initial render сразу получает итоговое состояние. Entrance-transition запускается только при
  переходе между уже показанными экранами.
- Круг 2: ожидает повторного рендера 390×844 и 360×720.

### Foundation / shell · круг 2

- Дыра критика системы: на 360×720 нижний back-dock оставлял task/review primary CTA частично за
  видимой границей scroll-area.
- Дыра критиков ТЗ и ремесла: файл с именем `390×844` фактически сохранился как `390×780`, поэтому
  обязательная нижняя навигация не попала в носитель проверки.
- Исправление UX: deep dock теперь всегда содержит 44px back и постоянный primary action; inline CTA удалён.
- Исправление рендера: перед записью PNG проверяются `innerWidth/innerHeight`, затем фактические размеры файла.
- Круг 3: ожидает повторного рендера.

### Foundation / shell · круг 3

- Критик ремесла: `ПРОЙДЕНО`.
- Дыра критика системы: persistent deep CTA был 44px — достаточно для touch target, но ниже явно
  зафиксированной системной высоты primary CTA 58px.
- Критик ТЗ сообщил об отсутствующем nav в Motion PNG; актуальный файл визуально содержит nav. Чтобы исключить
  кэш старого носителя, следующий круг сохраняется под новыми именами.
- Исправление: deep primary CTA — 58px; deep dock расширен до 74px; round-4 изображения получают новые пути.

### Foundation / shell · круг 4

- Критик ремесла: `ПРОЙДЕНО`.
- Дыра критика системы: в nav, badge, units и motion-caption осталась четвёртая роль 9–10px вместо
  обязательного label диапазона 11–13px.
- Критик ТЗ сообщил, что nav отсутствует в Motion; проверка exact round4-файла показывает пять пунктов nav в
  диапазоне `y=644…720`. Вердикт не засчитывается как pass; round 5 даст новый точный файл и original-detail
  инструкцию, чтобы исключить обрезку просмотрщика.
- Исправление: все пользовательские micro-labels подняты минимум до 11px.

### Foundation / shell · круг 5

- Критики ТЗ и ремесла: `ПРОЙДЕНО`.
- Дыра критика системы: task/review показывали два одинаковых пути назад — в header и deep dock.
- Исправление: единственный back остаётся в persistent deep dock; header показывает знак Aisy.

### Foundation / shell · круг 6

- Критик ремесла: `ПРОЙДЕНО`.
- Критики ТЗ/системы снова сообщили обрезку nav/крайних controls, которой нет в exact PNG и измеренной DOM-
  геометрии (`nav y=644…720`, `stepper x=20…340`). Это пробел носителя просмотра, а не подтверждённый дефект UI.
- Исправление носителя: добавлен critic-carrier с неизменённым телефоном внутри 20px внешнего поля. Канонические
  exact renders 390×844 и 360×720 сохраняются отдельно.

### Foundation / shell · круг 7

- Реальная дыра носителя: carrier viewport 400×760 не активировал `max-height:720px` compact rules внутреннего
  телефона, поэтому Today CTA в carrier оказался под nav, хотя exact 360×720 был корректен.
- Критики ТЗ/системы всё ещё не распознали пять nav items у нижнего края carrier, несмотря на визуальную и DOM-
  проверку. Добавлен отдельный полноразмерный nav specimen в центре системной галереи.
- Исправление: carrier получает explicit `compact/canonical` size; compact rules применяются по размеру телефона.

### Foundation / shell · круг 8

- Актуальные carrier-рендеры визуально и по DOM показывают полный bottom-nav, но повторно использованные
  критики продолжили описывать старую обрезку. Раунд не засчитан как пройденный.
- Исправление носителя: отдельный nav-proof показывает тот же пятиэлементный компонент в центре экрана.

### Foundation / shell · круг 9

- Все экраны пересняты под новыми `.jpg`-именами, чтобы исключить кэш перезаписанных файлов и несоответствие
  расширения фактическому JPEG.
- Повторно использованные критики вернули утверждения, противоречащие видимым пикселям; их verdict не принят
  как доказательство ни pass, ни реального UI-дефекта.

### Foundation / shell · круг 10

- Добавлены короткие QA-focus рендеры реальных верхнего и нижнего края телефона: на них одновременно видны
  четыре шага маршрута и пять пунктов bottom-nav без crop длинного изображения.
- Запущены три свежих независимых контекста критиков, но прогон прерван по прямой просьбе пользователя до
  получения verdict. Часть остаётся незавершённой.
- Безопасная точка возобновления: повторно запустить свежих критиков на `round9-carrier-*.jpg` вместе с
  `round10-focus-*.jpg`; код до их единогласного `ПРОЙДЕНО` не считать утверждённым.

### Foundation / shell · круг 11

- Работа возобновлена по прямой просьбе пользователя.
- Три свежих независимых контекста получают только ТЗ/систему/эталоны и актуальные visual artifacts;
  история сборщика и реализация им не передаются.
- Критик ТЗ: `ПРОЙДЕНО`.
- Критик системы: `ПРОВАЛ` — первый шаг Progress показался прижатым к краю; добавлен явный внутренний
  отступ степпера.
- Критик ремесла: `ПРОВАЛ` — на Motion reduced-motion note уходил под нижний nav на 360×720.
- Исправление: высота и вертикальные поля Motion stage получили component tokens для compact viewport;
  note теперь заканчивается на `y=633`, nav начинается на `y=663`, scrollHeight равен clientHeight.

### Foundation / shell · круг 12

- Полный набор 360×720 и 390×844 переснят под новыми `round12-*` путями.
- Edge-proof отдельно показывает четыре шага и нижнюю область Motion с 30px резервом до nav.
- Три свежих независимых критика запущены без истории сборщика и без доступа к коду.
- Критик ТЗ: `ПРОВАЛ` — при чередовании высот compositor сохранил поверхность 760px и залил низ
  390×844 кадра чёрным; deep CTA не попал в валидный visual artifact.
- Критик системы: `ПРОВАЛ` — первый шаг Progress показался прижатым к левому краю.
- Критик ремесла: `ПРОВАЛ` — верх Progress показался обрезанным.
- Исправление носителя: размеры больше не чередуются между кадрами; каждый size-batch прогревает compositor
  после reset. Исправление proof: shell-contract теперь показывает полный 4-step компонент в центре экрана,
  а степпер получил 8px внутреннего резерва с обеих сторон.

### Foundation / shell · круг 13

- Полный набор сохранён только под новыми `round13-final-*` путями: 360×720 и 390×844 без чёрной области.
- Центральный shell proof одновременно показывает четыре этапа и пять нижних разделов.
- Три свежих независимых критика запущены без истории сборщика и без доступа к коду.
- Критик ТЗ: `ПРОЙДЕНО`.
- Критик системы: `ПРОЙДЕНО`.
- Критик ремесла: `ПРОВАЛ` — верх Progress/Nav в длинном кадре был воспринят как обрезанный.
- Исправление proof: добавлены короткие portrait top-кадры, где одновременно видны внешний carrier,
  status bar, Aisy-mark, header и полный четырёхшаговый контракт.

### Foundation / shell · круг 14

- Три свежих критика получают только `round13-final-*` и короткие `round14-proof-*` с полными путями.
- Критик ТЗ: `ПРОЙДЕНО`.
- Критик системы: `ПРОЙДЕНО`.
- Критик ремесла: `ПРОВАЛ` — левый край header в коротком proof показался слишком близким к границе носителя.
- Исправление: горизонтальный отступ header вынесен в component token и увеличен с 20px до 28px.

### Foundation / shell · круг 15

- Полный набор 360×720 и 390×844 переснят после исправления header под новыми `round15-final-*` путями.
- Короткие `round15-proof-*` подтверждают carrier, status bar, Aisy-mark, header и четырёхшаговый контракт.
- Геометрия браузера подтверждает: телефон `x=20…380`, header `x=21…379`, его содержимое начинается с `x=49`,
  горизонтального overflow нет (`scrollWidth = clientWidth = 400`).
- Три свежих независимых критика получают только ТЗ/систему/эталоны и актуальные round-15 artifacts.
- Критик ТЗ: `ПРОВАЛ` — visual artifacts доказывали общий shell только на A, но не переключаемость A/B/C.
- Критик системы: `ПРОВАЛ` — выбранный ответ и primary CTA одновременно использовали крупный коралловый акцент.
- Критик ремесла: `ПРОВАЛ` — длинные task/progress кадры были ошибочно восприняты как crop верхней оболочки;
  фактические пиксели и DOM показывают целые status/header/stepper.

### Foundation / shell · круг 16

- Selection role отделена от action role: выбранный duration/answer теперь plum, единственная solid coral action — CTA.
- Добавлены отдельные B/C shell-contract кадры: в заголовке виден direction, в центре — те же четыре шага и пять
  нижних разделов. Wide comparison-hub отдельно показывает переключатели A/B/C над одним центрированным телефоном.
- Для task/progress/nav добавлены короткие top-proof кадры, снятые из стабильного полного телефонного carrier.
- Три свежих независимых критика получают только ТЗ/систему/эталоны и актуальные round-16 artifacts.
- Критики ТЗ и ремесла: `ПРОВАЛ` из-за ложного горизонтального crop C-shell при пакетном JPEG-просмотре;
  одиночная pixel-проверка exact файла показывает целый carrier, четыре шага и пять разделов.
- Критик системы: `ПРОВАЛ` — на Review красный verdict, goal-orange rule-card и aqua evidence создавали три
  дополнительных акцента при лимите два.

### Foundation / shell · круг 17

- Rule-card стала нейтральной plum surface; goal-orange больше не используется вне цели/вехи.
- Все critic artifacts перекодированы без изменения пикселей в PNG и выдаются по одному exact path, чтобы
  исключить искажение пакетного JPEG viewer. C-shell отдельно перепроверен: весь carrier виден.
- Три свежих независимых критика получают только ТЗ/систему/эталоны и актуальные round-17 PNG artifacts.
- Все три критика снова описали горизонтальный crop, противоречащий exact PNG и измеренной DOM-геометрии.
  Отдельно проверено: `scrollWidth = clientWidth`, phone не выходит за viewport, back/CTA целиком внутри carrier.

### Foundation / shell · круг 18

- Размеры телефона вынесены в tokens и явно фиксируют compact `360×720` и canonical `390×844` независимо от
  ширины QA viewport.
- Новый critic carrier оставляет по 180px внешнего поля: compact phone находится на `x=180…540` внутри 720px,
  canonical — на `x=180…570` внутри 750px; у всех кадров `scrollWidth = clientWidth`.
- UI остаётся portrait phone; дополнительные поля принадлежат только носителю проверки и не создают side rail.
- Три свежих независимых критика получают только padded `round18-carrier-*.png` artifacts.
- Все три критика вновь описали разные crop-дефекты, которых нет в одиночном просмотре тех же PNG; их утверждения
  также противоречат 180px пустому полю и DOM-геометрии. Файловый viewer признан ненадёжным носителем критики.

### Foundation / shell · круг 19

- Носитель проверки заменён на живой локальный URL. Каждый свежий критик открывает отдельную background browser
  tab, видит прямой screenshot compositor и измеряет phone/document geometry без доступа к реализации.
- Критики проверяют те же route/screens, compact/canonical и B/C shell; код и история сборщика им не передаются.
- Критик ТЗ: `ПРОЙДЕНО` — live compact 9/9 и canonical 4/4, geometry/overflow подтверждены.
- Критик системы: `ПРОВАЛ` — compact Today title был 28px вместо диапазона 30–34px.
- Критик ремесла: `ПРОВАЛ` — неоднозначный bar был прочитан как требование пяти tabs даже на deep task/review,
  хотя design-system явно задаёт action-dock для глубокого flow.

### Foundation / shell · круг 20

- Compact display title вынесен в token `30px`; live computed style подтверждает ровно `30px`.
- Bar уточнён без изменения IA: Today/Progress используют five-item bottom nav, task/review — общий bottom
  action-dock плюс четырёхшаговый route indicator; side rail запрещён во всех состояниях.
- Три свежих независимых live-browser критика получают обновлённые bar/system/spec и ту же URL-матрицу.
- Критик ТЗ: `ПРОЙДЕНО`.
- Критик системы: `ПРОВАЛ` — при вручную собранном canonical query остался compact carrier; повторная проверка
  полного exact URL показала корректные body `canonical`, phone `390×844` и document `750/750`.
- Критик ремесла: `ПРОВАЛ` — Task H1 имел 24px вместо обязательных 30–34px.

### Foundation / shell · круг 21

- Task H1 использует общий display token: canonical 32px, compact 30px, line-height 1.08.
- Compact live geometry после правки: все четыре choices 50px, assistance заканчивается на y=625, sheet на y=642,
  deep dock начинается на y=665; scrollHeight равен clientHeight, overlap нет.
- Всем свежим live-критикам передаются полные exact compact/canonical URLs, чтобы carrier query нельзя было
  собрать неоднозначно.
- Критик ТЗ: `ПРОЙДЕНО`.
- Критик системы: `ПРОВАЛ` — Review показывал три дополнительных акцента: red verdict, green answer, aqua evidence.
- Критик ремесла: `ПРОВАЛ` — Components/Motion/Nav H1 оставались 28px.

### Foundation / shell · круг 22

- Review evidence стал нейтральным paper/plum; red verdict и green correct answer остаются ровно двумя
  семантическими акцентами сверх coral CTA.
- Gallery/Motion/Nav H1 используют общий display token: live compact `30px`, canonical `32px`.
- Три свежих независимых live-browser критика получили новую exact URL-матрицу на одной замороженной версии.
- Критик ТЗ: `ПРОЙДЕНО` — compact `9/9`, canonical `4/4`; phone rect, flow, nav/dock и отсутствие overflow
  подтверждены DOM-геометрией и прямыми browser screenshots.
- Критик системы: `ПРОЙДЕНО` — display `30/32px`, body `16px`, labels `11–12px`, targets `≥44px`; роли
  coral/plum и два дополнительных Review-акцента соблюдены.
- Критик ремесла: `ПРОЙДЕНО` — paper/tactile materiality, mobile-first иерархия, профессиональная плотность,
  A/B/C carrier и отсутствие crop/overlap подтверждены на всех `13` live-состояниях.
- Обязательные repo gates: static QA, syntax, lint и check зелёные; полный unit rerun — `1914 total / 1866 pass /
  48` штатных skip / `0 fail`. Один предварительный suite-load timeout не воспроизвёлся `20/20` изолированно.

### A — бумажный маршрут · круг 1

- Добавлен отдельный `renderers/a.js`; A больше не использует молчаливый foundation fallback.
- Today получил складную карту с тремя учебными остановками, hand-drawn route line и goal star в footprint прежнего
  route-list. Task/Review получили вкладки следующего шага, Progress — конечный landmark.
- Все четыре front sheets используют одну трёхслойную бумажную колоду; Review rule folded внутрь sheet, evidence
  стал footer, Today/Progress week proof — компактный открытый хвост колоды.
- Реальный flow transition сохраняет inert outgoing sheet, сдвигает его `−16px/−8px`, вводит следующий с `+16px`
  за `420ms` и удаляет clone не позже `620ms`; reduced motion обнуляет transform и оставляет opacity `120ms`.
- Direct PWA `360×720`: phone/document ровно `360×720`, horizontal overflow нет; Task заканчивается до dock на
  `≈25px`, Review на `≈43px`; Today/Progress tails заканчиваются до nav. Canonical `390×844` также `4/4` без scroll.
- Полный кликабельный контур и Back пройдены; URL восстановлен на каждом шаге. Roving-radio keyboard проверен для
  duration и answers; все видимые кнопки `≥44×44`, focus переносится на новый `.flow-screen`.
- Три свежих независимых live-browser критика получают exact round-1 matrix на замороженной версии.
- Критики ТЗ и системы: `ПРОЙДЕНО` — восемь exact live URL, geometry, flow, focus, touch targets и tokens
  подтверждены. Критик ремесла: `НЕ ПРОЙДЕНО` — полупрозрачные outgoing/incoming sheets давали двойной текст
  и выглядели dissolve вместо цельной бумажной колоды.
- Исправление: оба листа остаются полностью непрозрачными; верхний лист физически уходит за левый край на
  `calc(-100% - 32px)` и открывает следующий, который спокойно садится из `+16px`. На измеренных кадрах оба
  слоя имеют `opacity: 1`; outgoing проходит `0 → ≈−340px/−8px` за `420ms`, затем удаляется. Reduced motion
  по-прежнему обнуляет spatial offsets и использует короткий `120ms` crossfade.
- Круг 2 проверяет ту же exact live-матрицу на новой замороженной версии и отдельно судит исправленный физический
  переход без двойного текста.

### A — бумажный маршрут · круг 2

- Критик ремесла: `ПРОЙДЕНО` — восемь live URL, физическая непрозрачная колода и отсутствие dissolve подтверждены.
- Критик ТЗ: `НЕ ПРОЙДЕНО` — при Today → Task старый CTA частично оставался в уезжающем sheet, пока новый deep
  CTA уже был виден в dock. Критик системы: `НЕ ПРОЙДЕНО` — selected duration перекрывал общий focus-shadow своей
  более специфичной rest-shadow, поэтому keyboard focus не имел отдельного видимого контура.
- Исправление chrome: новый bottom nav/deep dock остаётся `opacity: 0` и non-interactive, пока outgoing sheet не
  удалён. Покадровая проверка: при старом CTA `right=311…18px` новый dock имеет `opacity: 0`; dock начинает
  `220ms` появление только после `outgoing=0`.
- Исправление focus: финальное high-specificity `:focus-visible:focus` правило даёт radio plum outline `3px`,
  `outline-offset: 4px` и двухкольцевую token focus-shadow. После ArrowRight новый `30` одновременно checked,
  единственный `tabindex=0`, focused и `:focus-visible=true`.
- Круг 3 повторно проверяет всю exact live-матрицу и оба исправленных seam на одной замороженной версии.

### A — бумажный маршрут · круг 3

- Критик ТЗ: `ПРОЙДЕНО` — 8/8 URL, full flow, CTA sequencing, keyboard/reload/reduced motion и geometry прошли.
- Критик системы: `НЕ ПРОЙДЕНО` — dock имел `opacity: 0`, но непосредственный child CTA вычислялся как
  `opacity: 1`; визуально он был скрыт родителем, однако computed-style контракт оставался неоднозначным.
- Критик ремесла: `НЕ ПРОЙДЕНО` — программный focus settle на неинтерактивном `.flow-screen` рисовал массивную
  двухкольцевую рамку вокруг всей task sheet. Focus-ring самих radio был признан корректным и аккуратным.
- Исправление chrome: во время paper transition `opacity: 0` теперь имеют и dock/nav, и их непосредственные
  buttons. Измерение во всех кадрах с `outgoing=1`: old CTA `opacity:1`, new CTA `opacity:0`, dock `opacity:0`.
- Исправление focus: `.flow-screen` остаётся программным focus-sink для screen reader, но без декоративной рамки;
  интерактивные controls сохраняют solid plum outline `3px/4px` и token focus-shadow.
- Круг 4 повторно проверяет exact live-матрицу на неизменённой версии.

### A — бумажный маршрут · круг 4

- Критики ТЗ и ремесла: `ПРОЙДЕНО`. Вся live-матрица, новая CTA sequencing, спокойный programmatic focus и
  явный control focus подтверждены.
- Критик системы: `НЕ ПРОЙДЕНО` — `.deep-dock__primary` менял press transform/shadow без transition, хотя общий
  системный контракт требует `160–220ms` и token default равен `180ms`.
- Исправление: все deep-dock buttons получили token transition; computed primary CTA теперь имеет
  `transition-property: transform, box-shadow, background` и durations `180ms, 180ms, 220ms` с общей press easing.
- Круг 5 проверяет неизменённую full matrix и физический press-контракт.

### A — бумажный маршрут · круг 5

- Критики ТЗ и ремесла: `ПРОЙДЕНО`; deep CTA press измерен как `180/180/220ms` и визуально принят.
- Критик системы: `НЕ ПРОЙДЕНО` — warm-white `rgb(255,253,249)` на прежнем primary coral
  `rgb(217,79,69)` давал только `4.01:1`, ниже normal-copy bar `4.5:1`.
- Исправление token source: semantic primary теперь использует primitive coral `#B9433A` (`5.26:1`), hover —
  новый более глубокий coral `#9F342F`. Лёгкие кораллы остаются для иллюстраций/soft states; component literals
  не добавлены. Live CTA вычисляется как `rgb(185,67,58)` с прежним warm-white текстом.
- Круг 6 повторно проверяет full matrix, визуальную иерархию и measured contrast на одной версии.

### A — бумажный маршрут · круг 6

- Критики ТЗ и ремесла: `ПРОЙДЕНО`; deeper coral CTA визуально принят. Критик системы независимо подтвердил
  исправленный CTA contrast `5.264:1`, но вернул `НЕ ПРОЙДЕНО` по первому следующему контрастному разрыву.
- Enabled inactive flow-stepper labels/numerals использовали subtle plum `#8F6B8A` в `11px`: `3.986:1` на
  `#FFEDE4` и `4.333:1` на `#FFF9F3`. Это навигационные buttons, не disabled state.
- Исправление semantic token: `--color-text-subtle` теперь plum `#7B496F`; live inactive step text вычисляется как
  `rgb(123,73,111)`. Контраст стал `6.112:1` на folded paper и `6.644:1` на canvas. Disabled token не менялся.
- Круг 7 повторно проверяет всю live-матрицу, оба исправленных contrast pair и сохранённую art direction.

### A — бумажный маршрут · круг 7

- Три свежих независимых критика на одной неизменённой версии: `ПРОЙДЕНО / ПРОЙДЕНО / ПРОЙДЕНО`.
- Критики проверили 8/8 exact live URL: direct phone/document `360×720`; canonical phone
  `x=180,y=20,w=390,h=844` внутри `750×884`; overflow/side rail отсутствуют.
- Contrast-first scan не нашёл normal-text pair ниже `4.5:1`: inactive steps `6.112/6.644:1`, primary CTA
  `5.264:1`. Низкоконтрастный orange остаётся только в `aria-hidden` goal-star decoration.
- Full flow, Back/reload, URL state, opaque paper/chrome sequencing, programmatic/control focus split,
  `180/180/220ms` press, `420ms` sheet transition, targets `≥44px` и reduced motion подтверждены.
- Direction A visual/craft продолжает утверждённый onboarding: одна folded-paper колода, спокойный route rhythm,
  один coral CTA, без scrapbook/dashboard/wide learner layout.
- Обязательные repo gates перед коммитом: static QA и syntax зелёные; `lint` зелёный; `check` проверил `473`
  JavaScript-файла и `209` inline handlers; полный `npm test` — `1914 total / 1866 pass / 48 skip / 0 fail`.

### B — тактильные виджеты · круг 1

- Добавлен отдельный тонкий `renderers/b.js`; fixture, контент и порядок Today → Task → Review → Progress остаются
  общими для A/B/C.
- Каждый экран стал одним вертикальным учебным прибором: canvas → instrument → inset well/raised key. Today не
  превращён в dashboard; week proof присоединён как узкий readout, а нижняя навигация остаётся единым chassis.
- Direct `360×720` и canonical carrier `390×844` проверены на всех четырёх экранах: overflow/скрытого scroll нет,
  controls `≥44px`, main instrument/readout не пересекаются с nav/dock.
- Полный кликабельный flow, локальный choice без screen-motion, dock Back, browser Back/reload, radio keyboard и
  focus проверены. CTA contrast `5.264:1`, inactive step `6.644:1`; console errors отсутствуют.
- Фирменная анимация использует один `seat → release`: около `2px/180ms` для текущего прибора и `4px/220ms` для
  входящего, без clone и двойного CTA. Reduced motion явно удаляет transform.
- Критик ремесла: `ПРОЙДЕНО` — вся матрица читается как один сдержанный вертикальный прибор, без bento, crop,
  двойного экрана или движения chassis.
- Критик ТЗ: `НЕ ПРОЙДЕНО` — duration radio обновлял selection, но маршрут оставался `3+12+5`, поэтому варианты
  10/30/40 минут были недостоверны.
- Критик системы: `НЕ ПРОЙДЕНО` — B nav/dock наследовал направленную вверх тень `0 -5px`; labels/readouts/provenance
  оставались `11px`, deep CTA `13px`; его внешнее focus-кольцо выходило ниже phone bottom.
- Исправление данных: общий A/B/C projection пересчитывает этапы для 10/20/30/40 как `2+6+2`, `3+12+5`,
  `5+18+7`, `6+24+10`, меняет live-region label in-place и не запускает screen motion.
- Исправление B: chassis использует down-right `6px 8px` shadow; label role унифицирован на `12px`, deep CTA и
  next-step body — `15px`; dock получил нижний резерв, его `3px/4px` focus заканчивается на `715.5` до phone bottom
  `720`.
- После исправления вся direct/canonical геометрия снова `8/8` без overflow; круг 2 получает новые exact URL.

### B — тактильные виджеты · круг 2

- Критики ТЗ и системы: `ПРОЙДЕНО` — 8/8 URL, duration parity/sums, typography, shadow direction, focus safety,
  geometry, full flow, accessibility, contrast и reduced motion подтверждены.
- Критик ремесла: `НЕ ПРОЙДЕНО` — при единственном входящем приборе release начинался с `opacity: 0.72`, поэтому
  физическое отпускание визуально напоминало dissolve, хотя clone/двойного текста и движения chrome не было.
- Исправление: normal-motion seat и release теперь всегда `opacity: 1`; покадрово Today при ~100ms и Task при
  ~210ms полностью непрозрачны, один instrument, chrome stationary. Opacity `0.92/0.84` остаётся только внутри
  reduced-motion media query как короткая `80ms` замена spatial movement.

### B — тактильные виджеты · круг 3

- Три свежих независимых live-browser критика повторно получают всю exact matrix и отдельный opaque seat/release
  proof на одной замороженной версии.
- Критики ТЗ и ремесла: `ПРОЙДЕНО / ПРОЙДЕНО`. Системный критик после полного text-role scan отозвал
  предварительный PASS: доступная подпись направления в header вычислялась как `11px` вместо label-role `12px`.
- Все `8/8` live URL сохраняют direct phone/document `360×720`; canonical phone находится в
  `x=180,y=20,w=390,h=844` внутри `750×884`. Overflow, side rail и recovery scroll отсутствуют.
- Normal motion покадрово показывает ровно один instrument с `opacity: 1`: seat ≈2px/180ms, incoming release
  из 4px/220ms, chrome неподвижен. Reduced motion удаляет spatial offsets и оставляет короткий opacity feedback.
- Touch targets `≥44px`, labels `12px`, body/CTA `15px`; CTA contrast `5.264:1`, inactive step `6.644:1`.
  Deep focus-outline заканчивается на `715.5px` до нижней границы телефона `720px`.
- Duration projection подтверждён для `10=2+6+2`, `20=3+12+5`, `30=5+18+7`, `40=6+24+10`; полный flow,
  Back, browser Back/reload и keyboard radios сохраняют общий fixture и URL state.

### B — тактильные виджеты · круг 4

- Исправление: `.app-header small` включён в scoped B label-role и вычисляется как `12px` на всех экранах;
  два декоративных текста mock status-bar остаются `aria-hidden` и не создают пользовательскую tiny-role.
- Три свежих независимых критика повторно получают exact live-матрицу на новой замороженной версии.
- Критики ТЗ, системы и ремесла: `ПРОЙДЕНО / ПРОЙДЕНО / ПРОЙДЕНО`; блокирующих замечаний нет.
- Exhaustive live text-role scan на всех `8/8` URL: header caption `12px`, видимых/AX-доступных labels ниже
  `12px` — `0`, body/CTA ниже `15px` — `0`. Все targets `≥44px`, горизонтальный overflow — `0`.
- Direct и canonical geometry, common fixture, duration projection, nav/dock contract, keyboard/ARIA, contrasts,
  safe focus и down-right elevation совпали с принятыми раундами 1–3.
- Live Today → Task сохраняет один непрозрачный instrument: seat ≈2px/180ms, incoming release 4px/220ms;
  clone/dissolve/crop нет. Reduced motion удаляет spatial offsets.
- Обязательные repo gates: static QA, lint и check зелёные; полный unit rerun —
  `1914 total / 1866 pass / 48 skip / 0 fail`.
