# 08 — Premium commerce и полное покрытие grammar/lexicon

**What to build:** закрыть межтикетные продуктовые пробелы: Premium entitlement выдаётся и отзывается через реальный server-owned payment/admin flow, paywall ведёт в этот flow, короткие сессии не теряют остаток дневной квоты, production требует pinned voice model, а все поддерживаемые ошибки grammar/word-formation/lexicon/collocations имеют server-validated Voice Tutor tracer.

**Blocked by:** 01–07.

**Status:** done

- [x] Existing base purchase remains backward-compatible; Premium request/approval atomically grants subscription plus bounded `voice_tutor` entitlement and revoke/expiry is reflected in `/me`.
- [x] Premium paywall has an actionable, accessible request/upgrade path and cannot self-grant entitlement.
- [x] Reservation uses the bounded remaining daily/monthly allowance, so the advertised 10 minutes are actually consumable without exceeding any limit.
- [x] Production rejects blank/unversioned/`latest` voice model configuration before provider transport.
- [x] Every supported built-in/generated grammar, word-formation, lexicon and collocation error shown by the UI resolves to a server-owned item/attempt; no client answer/reference is trusted.
- [x] File/PostgreSQL/payment/audit/export/delete parity and targeted negative tests pass.
- [x] Full lint/check/test/build/PostgreSQL gates and independent Standards/Spec reviews pass.
