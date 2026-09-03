# ADR-001: Direct xAI ephemeral connection

Status: superseded by ADR-002 on 2026-08-03. Direct browser credentials are not used by the application.

ADR-002 replaced this boundary with a server-owned same-origin realtime proxy. This document is
retained only as historical decision context and must not be used as an implementation runbook.

## Context

The approved feature sends a short-lived xAI client secret to the browser and connects the
browser directly to xAI Realtime. The current xAI client-secret endpoint accepts only expiry
seconds. It cannot bind the bearer to our prompt, model, tools, session id or account, and it
does not provide per-secret revocation. Consequently, browser validation and `session.update`
are safety controls for the normal client, not a security boundary against a copied bearer.

## Decision

- Keep direct browser-to-xAI transport because a server WebSocket/audio proxy is outside the
  approved ticket and would create a new raw-audio processing boundary.
- Fix the credential lifetime to 60 seconds, intended only as the connection window.
- Keep the main xAI key server-only; never persist or log the client secret.
- Require current consent, Premium entitlement, quota reservation, one active session,
  idempotent issuance, pinned model/origin/CSP and bounded server-owned HTTP state transitions.
- Default `VOICE_TUTOR_UNBOUND_CREDENTIAL_RISK_ACCEPTED` to `false`. Production voice remains
  text/local until the owner explicitly accepts this residual risk.
- Treat feature and cost kill switches as controls for new issuance only. They cannot revoke an
  already-issued bearer; incident response assumes up to the remaining 60-second window.
- On missing `session.updated`, provider `error`, or unexpected close, close browser media and
  continue the same capsule through text/local fallback.
- Treat `session.updated` only as provider acknowledgement. The browser then calls an authenticated,
  idempotent activation endpoint; the backend owns `voice_activated_at`, and browser audio capture
  starts only after the activation response.
- Charge zero before activation and only elapsed seconds since activation afterwards. Preserve the
  original provider/model/prompt provenance through text/local downgrade for cost evidence.

## Consequences and replacement trigger

The residual risk is explicit rather than claimed as solved. Revisit this decision when xAI
offers prompt/model/tool/session-bound and revocable client credentials. If owner acceptance is
not granted, implement a separately reviewed realtime proxy with privacy, capacity, audio
handling and incident controls as a follow-up project; do not silently expand this ticket.
