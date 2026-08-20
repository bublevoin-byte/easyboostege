# 02 — Оболочка ученика и пять разделов

Status: done
Blocked by: 01
Spec: `.scratch/aisy-ux-redesign/spec.md#4-information-architecture`

## Что сделать

Ввести одну адаптивную learner shell с top-level navigation Сегодня / Практика / ЕГЭ / Прогресс / Профиль,
selected state, безопасным back behavior и пустыми route-safe host-контейнерами для новых hub экранов.

## Границы

- Входит единая нижняя навигация максимум из пяти пунктов и desktop adaptation.
- Входит сохранение legacy screen IDs и deep routes через adapter.
- Не входит наполнение Today/Practice/EGE.
- Не входит React.

## Файлы

- `public/aisy-shell.js`, `public/aisy-shell.css` — глубокий shell interface.
- `public/index.html`, `public/main.js`, `public/router.js`, `public/app.js` — host/route adapter.
- `public/service-worker.js` — offline shell closure.
- `test/frontend-aisy-shell.test.js`, `e2e/aisy-shell.test.js` — semantic + browser contract.

## Definition of Done

- [ ] Ровно пять top-level destinations доступны мышью, касанием и клавиатурой.
- [ ] Selected state объявляется визуально и через `aria-current`.
- [ ] Deep learning screens возвращают в правильный hub; active attempts не сбрасываются.
- [ ] 320/375/768/1440 px без horizontal overflow; controls >=44 px.
- [ ] `npm test`, `npm run lint`, `npm run check`, `npm run build:frontend` проходят.
- [ ] Один коммит: `feat(aisy): add learner shell navigation`.
