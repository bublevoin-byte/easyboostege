# 09 — Полный педагогический цикл и learner feedback

**What to build:** довести текущий разбор до обещанного UX: trusted discovery реально ищет allowlisted источники и подставляет provisional rule в текущую server-owned capsule/FSM, text fallback допускает bounded уточнение без сохранения реплики, voice поддерживает barge-in, ученик может структурированно сообщить о неверном объяснении, а E2E начинается с настоящей карточки ошибки модуля и проходит realtime tool-driven цикл.

**Blocked by:** 08.

**Status:** ready-for-agent

- [ ] Production search adapter получает кандидаты через server-only allowlisted web-search seam; fetched content остаётся untrusted, минимум два независимых источника и moderation gate сохраняются.
- [ ] Provisional rule/links атомарно привязываются к текущей owner-bound session и используются её explain/micro-check/transfer path; approved rule остаётся единственным общим canonical.
- [ ] Bounded clarify/explain-differently turns работают в text mode transiently, не меняют FSM без server event и не сохраняют learner free text.
- [ ] Server-VAD speech-start останавливает очередь output audio и отправляет bounded cancel/truncate; replay/off-order events fail closed.
- [ ] Learner report endpoint/UI хранит только structured reason/session/rule identifiers, имеет admin queue/audit, file/PostgreSQL/export/delete parity.
- [ ] Persisted Voice Tutor session минимизирована до IDs, versions, hashes/counters/outcome; full capsule/reference/answer arrays реконструируются server-side и не экспортируются.
- [ ] Playwright E2E использует реальную модульную error card и fake realtime tool calls через micro-check/transfer до recovery map.
- [ ] Full gates and independent Standards/Spec reviews pass.
