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

## Границы

**Входит:**

- `public/index.html`: удалить двадцать тегов `<script defer>`, добавить один модульный.
- Каждый файл `public/*.js`, `public/modules/*.js` — в ES-модуль с `export`.
- Новый `public/main.js`: импортирует модули, выполняет старт приложения, привязывает к `window`
  ровно 13 имён, которые вызываются из инлайновых обработчиков разметки, плюс `initWords`,
  `curTask` для `router.js` и `tab` для E2E. Список — в спеке, раздел 4.1. Проверить его по факту
  поиском по `public/index.html`, а не доверять списку на слово.
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
- [ ] Все 13 имён из инлайновых обработчиков и `window.tab` работают — проверено `npm run test:e2e`.
- [ ] CSP не ослаблена: `script-src` остаётся `'self'` плюс хеши инлайновых скриптов.
- [ ] `npm test` — 260 проходят, 1 пропущен, как до изменения.
- [ ] `npm run lint`, `npm run check`, `npm run build:frontend` проходят.
- [ ] `npm run test:e2e` проходит.
- [ ] Один коммит.
