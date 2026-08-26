# 07 — Перенести письмо, ожидание и AI-разбор

**What to build:** Оформить выбор письменного задания, редактор, отправку, ожидание и результат AI-проверки как
один последовательный paper route с честными limits/errors и сохранением введённого текста.

**Blocked by:** 03 — access check, Today и общая learner shell.

**Status:** ready-for-agent

**Spec anchor:** User Stories 16, 22–24, 26–28, 31–36, 40, 48.

- [ ] Catalog/prompt/editor/sending/waiting/review/retry/result используют одну deep-screen композицию и один CTA.
- [ ] Textarea, counters, validation, draft/saved state и focus labels доступны и визуально согласованы.
- [ ] AI waiting, ready, recoverable error, quota/limit и offline состояния имеют точную копию и live announcements.
- [ ] Review сначала показывает результат, затем исправление, правило, evidence и следующий шаг.
- [ ] Existing writing facts, assessment request, draft/storage и owner authority semantics не меняются.
- [ ] Клавиатура телефона, safe area и длинный feedback не перекрываются dock.
- [ ] Writing/AI review unit и browser tests проходят с новым observable UI.

