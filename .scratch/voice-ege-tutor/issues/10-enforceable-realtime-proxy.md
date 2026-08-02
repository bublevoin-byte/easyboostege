# 10 — Enforceable realtime proxy и финальная security parity

**What to build:** заменить неограничиваемый browser bearer на server-owned realtime WebSocket proxy с одноразовым app ticket, жёстким session timeout и подтверждённым учётом input+output audio; закрыть оставшиеся provider, finalization, account-race и canonical-consistency findings.

**Blocked by:** 09.

**Status:** ready-for-agent

- [ ] Browser никогда не получает xAI credential/API key; one-use app ticket owner/session-bound, short-lived, atomically consumed and replay-safe.
- [ ] Proxy сам подключается к pinned xAI model, отправляет bounded server-owned session config, разрешает только expected realtime frames/tools and closes both sides at reserved deadline/kill switch.
- [ ] Billable usage and estimated cost derive from server-observed input+output audio bytes/provider usage; without confirmed usage reservation remains conservative; no client wall-clock self-report.
- [ ] Proxy disconnect/finalization is server-owned and reliable across tab close/network loss; lost `201`/ticket response has a recoverable idempotent path.
- [ ] Credential/provider bodies are streamed with hard byte caps; expiry/contract validation fail closed.
- [ ] PostgreSQL/file user-review/delete races are serialized, and at most one approved canonical rule exists per skill/year with transactional conflict handling.
- [ ] Fake local HTTP+WebSocket E2E exercises the real proxy, barge-in, runtime fallback, usage, quota, recovery map and privacy assertions without paid calls.
- [ ] Full lint/check/test/PostgreSQL/E2E/performance/build/secret gates and final whole-feature Standards/Spec reviews pass.
