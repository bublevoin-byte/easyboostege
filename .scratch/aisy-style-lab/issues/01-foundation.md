# 01 — Общая дизайн-система и контракт сравнения

**What to build:** Опубликовать проверяемую трёхслойную дизайн-систему Aisy и единый fixture/state-контракт, на которых будут собраны все три направления, чтобы цвета, типографика, состояния, контент и данные нельзя было незаметно развести между вариантами.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Primitive → semantic → component tokens имеют один источник и документированы.
- [x] Зафиксированы типографика, spacing, radius, elevation, motion, accessibility и bottom-nav контракты.
- [x] Один fixture/state-контракт покрывает Today, task, review, Progress и gallery states.
- [x] Компонентные стили не используют raw palette values вне primitive layer.
- [x] Планка из `bar.md` прослеживается до токенов и спецификаций.

Verification: fixture ES-module syntax PASS; raw-hex-after-primitives scan PASS.
