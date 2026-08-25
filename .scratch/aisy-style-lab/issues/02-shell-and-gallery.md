# 02 — Телефонный comparison hub и системная галерея

**What to build:** Дать владельцу один URL с portrait-only телефонным canvas, переключением A/B/C, четырьмя маршрутными шагами, component/state gallery и motion replay, чтобы систему можно было оценить до просмотра отдельных art directions.

**Blocked by:** 01 — Общая дизайн-система и контракт сравнения.

**Status:** done — design-loop round 22

**Current gate:** round 22 закрыт тремя свежими независимыми verdict `ПРОЙДЕНО` на одной замороженной live-сборке:
ТЗ, дизайн-система и визуальное ремесло. Проверено `9` compact и `4` canonical URL.

- [x] На 390×844 и 360×720 нет горизонтального overflow и перекрытия safe-area.
- [x] На широком окне learner UI остаётся центрированным телефоном; бокового rail нет.
- [x] URL хранит direction, screen и fixture state; reload сохраняет точку просмотра.
- [x] Gallery показывает кнопки, choice, hero, badge, progress, alert и bottom-nav в ключевых состояниях.
- [x] Motion lab умеет повторить A/B/C signature и имеет reduced-motion представление.
