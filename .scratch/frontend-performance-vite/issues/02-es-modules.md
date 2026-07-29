# 02 — Перевести frontend на нативные ES-модули

Status: ready-for-agent
Blocked by: 01
Spec: .scratch/frontend-performance-vite/spec.md#41-модульность

## Что сделать

Заменить двадцать классических `<script defer>` в `public/index.html` на одну точку входа
`<script type="module" src="/main.js">`. Все файлы `public/*.js` и `public/modules/*.js` становятся
ES-модулями с явными `export`, а `main.js` собирает их в приложение и явно привязывает к `window`
только те имена, которые нужны разметке и E2E.

Без сборщика и без единой новой зависимости: браузер понимает ES-модули нативно. Поведение
приложения не меняется — это чисто механический перевод, который открывает дорогу тикету 03.

## Карта зависимостей между файлами

Проверено разбором: `api.js`, `auth.js`, `sync.js`, `store.js`, `components.js`, `learning.js`,
`privacy.js`, `pwa.js` и все девять `modules/*.js` — это IIFE, публикующие себя как
`window.EasyBoostЧто-то`. Они становятся ES-модулями без единой правки: достаточно их
импортировать. Единственное исключение — `pwa.js` читает голое имя `toast` из `app.js` через
`typeof toast==='function'`; в модуле это молча перестанет показывать уведомление об обновлении,
а не упадёт, поэтому обращение нужно сделать явным.

Настоящую работу требуют три файла:

| Файл | Что отдаёт наружу | Что берёт снаружи |
|---|---|---|
| `router.js` | `tab`, `nav`, `show`, `showScreen`, `back`, `cur`, `registerRouteHook`, `HIST` | `initWords`, `setTask`, `curTask` из `app.js` |
| `tts.js` | `wSpeak`, `lPlayRaw`, `lStop` | `apiGetBlob`, `lPlayBtn`, `lStopFallback`, `lPlayRawFallback`, `wSpeakFallback`, `SRV`, `TOKEN`, `LSLOW` из `app.js` |
| `app.js` | всё перечисленное выше плюс имена обработчиков | `tab`, `nav`, `show`, `back`, `cur`, `HIST`, `registerRouteHook` из `router.js`; `wSpeak`, `lPlayRaw`, `lStop` из `tts.js` |

`router.js` ↔ `app.js` и `tts.js` ↔ `app.js` — циклы. Разрывать их статическим импортом нельзя:
`main.js` импортирует файлы в том же порядке, в каком они стояли тегами, и если `router.js`
потянет `app.js`, тот выполнится раньше `modules/*.js`, а он читает `window.EasyBoostWords` на
верхнем уровне — получит `undefined`.

Разрывать так:

- `router.js` перестаёт знать про `app.js`. Строки `if(id==='scr2')initWords()` и
  `if(id==='scr8')setTask(curTask)` из `tab()` переезжают в маршрутный хук, который регистрирует
  `app.js` через уже существующий `registerRouteHook`. Хук должен быть зарегистрирован первым,
  чтобы порядок вызовов не изменился.
- `tts.js` получает зависимости вызовом вида `configureTts({...})` из `app.js`, а не читает их
  из области видимости.

## Границы

**Входит:**

- `public/index.html`: удалить двадцать тегов `<script defer>`, добавить один модульный.
- Каждый файл `public/*.js`, `public/modules/*.js` — в ES-модуль с `export`.
- Новый `public/main.js`: импортирует модули в прежнем порядке и выполняет старт приложения.
- Явная привязка к `window` всех имён, к которым обращаются инлайновые обработчики.

## Что выяснено разбором перед постановкой задачи

Инлайновых обработчиков не 22, а 120: **22 написаны в разметке** `public/index.html` и ещё
**98 генерируются в рантайме** внутри строк в `public/app.js` — например
`'<button onclick="LSLOW=!LSLOW;...">'` или `'<div onclick="gPick('+i+')">'`. Все они разрешают
имена через `window` в момент клика, и все перестанут работать в модуле, где объявление функции
глобального имени не создаёт.

Разметка обращается к 13 именам: `tab`, `nav`, `setTask`, `r_add`, `countWords`, `wSpeak`,
`tgClick`, `startDemo`, `openLearn`, `logout`, `checkWriting`, `wShowKnown`, `lastWord`.

Сгенерированные обработчики обращаются примерно к семидесяти именам из `app.js`: `gPick`, `gStart`,
`gSubmit`, `gExam*`, `wPick`, `wNext`, `wRender`, `wSubmit`, `rHub`, `rQs*`, `rHl*`, `rGp*`,
`rExam*`, `lHub`, `lIq*`, `lMt*`, `lTf*`, `lExam*`, `sp*`, `wr*`, `sel*`, `trWord`, `learnGo`,
`closeLearn`, `pwCheck`, `rSync`, `initGrammar`, а также изменяемые переменные `LSLOW`, `gi`, `GS`,
`WI`, `WQ`, `RQ`, `SP`, `LE`, `RE`, `SPE`.

**Точный список получить скриптом, а не глазами.** Разобрать все `on*="..."` в `public/index.html`
и в строках `public/*.js`, `public/modules/*.js`, вычесть зарезервированные слова и обращения к
свойствам. Скрипт разбора приложить к тикету или положить рядом — он же нужен для проверки, что
после правки ни одно имя не потерялось.

Переменные, которые обработчик не только читает, но и присваивает (`LSLOW=!LSLOW`, `gi`), требуют
живой связи, а не копии значения на момент старта. Здесь есть выбор: либо переписать такой
обработчик на вызов функции (`onclick="toggleSlow()"`), либо связать через аксессор. Первое честнее
и предпочтительно — присваивание глобальной переменной из разметки переживать в модульном коде
незачем.
- `public/service-worker.js`: список кэшируемых файлов привести в соответствие.
- `scripts/build-frontend.js`: проверка `<script src=...>` должна понимать модульный тег.
- Тесты, которые читают исходники и утверждают что-то про порядок скриптов, — обновить под новую
  структуру, не ослабляя проверок.

**Не входит:**

- Ленивая загрузка и динамический `import()` — тикет 03.
- Разделение синхронной отрисовки — тикет 04.
- Vite — тикет 06.
- Любое изменение поведения приложения для ученика.

## Файлы

- `public/index.html`
- `public/main.js` — новый
- `public/{api,auth,sync,store,components,router,learning,app,privacy,tts,pwa}.js`
- `public/modules/{words,grammar,reading,listening,writing,speaking,exam,progress,profile}.js`
- `public/service-worker.js`
- `scripts/build-frontend.js`
- `package.json` — список файлов в `npm run check`
- `test/*.test.js` — там, где проверяется структура подключения скриптов

## Definition of Done

- [ ] `public/index.html` содержит ровно один тег `<script>` c `src` и он `type="module"`.
- [ ] Ни один файл frontend не полагается на то, что объявление функции создаёт глобальное имя.
- [ ] Скрипт разбора обработчиков подтверждает: каждое имя из всех 120 обработчиков доступно —
      либо привязано к `window`, либо обработчик переписан на функцию.
- [ ] `window.tab` работает — им пользуется `e2e/performance.test.js`.
- [ ] CSP не ослаблена: `script-src` остаётся `'self'` плюс хеши инлайновых скриптов.
- [ ] `npm test` — 260 проходят, 1 пропущен, как до изменения.
- [ ] `npm run lint`, `npm run check`, `npm run build:frontend` проходят.
- [ ] `npm run test:e2e` проходит.
- [ ] Один коммит.
