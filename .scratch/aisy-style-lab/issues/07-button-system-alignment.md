# 07 — Согласовать кнопочную систему с утверждённым onboarding

**Status:** done — approved with direction A

**What to build:** Заменить generic web-button treatment в Style Lab на одну общую кнопочную систему, буквально
наследующую утверждённый onboarding CTA и светлые tactile keys из widget-reference. В первую очередь проверить
направления A и B; общий foundation не должен расходиться между flow и component gallery.

**References:**

- `C:/Users/4FE4~1/AppData/Local/Temp/codex-clipboard-ca46ca60-ec21-4da2-b318-7dc5bfd14022.png`
- `C:/Users/Ригер/Downloads/92c25a71d74dd8ddb6b4d1298cb13ac8.jpg`
- утверждённая реализация `.onboarding[data-lower-variant="a"][data-lower-style="reference"] .onboarding__next`.

**Blocked by:** 06 — финальное comparison готово.

- [x] Primary и deep primary имеют onboarding-анатомию: `58 / 28 / 26 / 10 / 38`.
- [x] Secondary, disabled и answer-choice выглядят как выпуклые paper/widget keys, а не generic outline buttons.
- [x] Default/hover/active/focus/disabled и reduced-motion проверены.
- [x] A/B flow и component gallery проходят `360×720` и `390×844` без horizontal overflow, потери CTA или focus.
- [x] Raw component colors отсутствуют; изменения идут через primitive → semantic → component tokens.
- [x] Три свежих независимых критика вынесли `ПРОЙДЕНО` на актуальных рендерах.

## Comments

- Владелец выбрал A/B как сильные направления, но отклонил текущую форму кнопок как несогласованную с
  утверждённым onboarding и повторно приложил оба эталона.
- Круг 1 подтвердил primary, но выявил generic outline у B choices и потерю светлого круга в disabled CTA.
- Круг 2 закрыл оба разрыва; один критик дополнительно выявил доминирующий outline у B selected.
- Круг 3 заменил outline мягкой кромкой и усилил sunken-seat. Свежие критики ТЗ, тактильной системы и ремесла:
  `ПРОЙДЕНО / ПРОЙДЕНО / ПРОЙДЕНО`.
- Актуальная matrix A/B × шесть состояний × два телефонных размера: `24/24`, failures `0`; targeted selected
  regression на обоих размерах: `2/2`. Static QA, focused lint, check и diff-check зелёные.
- Production UI, API, storage и service worker не изменялись. После round 3 результат был передан владельцу на
  визуальное решение.
- 2026-08-26: владелец выбрал направление A; кнопочная система закрыта как часть утверждённой основы.
